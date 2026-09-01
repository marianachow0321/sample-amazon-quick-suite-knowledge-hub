# Deployment Runbook — Cognito OIDC Provider for Amazon Quick on Desktop

Field notes from deploying this sample, covering what the upstream README does
not. All account identifiers, IPs and endpoints below are placeholders (RFC 5737
documentation ranges and the reserved `123456789012` account ID).

Source: [aws-samples/sample-amazon-quick-suite-knowledge-hub](https://github.com/aws-samples/sample-amazon-quick-suite-knowledge-hub/tree/main/docs/amazon-quick-on-desktop)

---

## Quick path

The whole deployment, open to the internet, no IP restriction. Everything below
this section is reference for when one of these steps fails.

```bash
# 1. Get the code. On CloudShell use /tmp — $HOME has a ~974 MB quota and
#    node_modules is ~680 MB.
cd /tmp
git clone --depth 1 --filter=blob:none --sparse \
  -b fix/allowedcidrs-not-enforced \
  https://github.com/marianachow0321/sample-amazon-quick-suite-knowledge-hub.git repo
cd repo && git sparse-checkout set docs/amazon-quick-on-desktop
cd docs/amazon-quick-on-desktop
export npm_config_cache=/tmp/npm-cache          # CloudShell only: npm caches in $HOME
PUPPETEER_SKIP_DOWNLOAD=1 npm install

# 2. Environment. Local: export AWS_PROFILE=<profile> as well.
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-east-1
echo "$CDK_DEFAULT_ACCOUNT $CDK_DEFAULT_REGION"   # check before continuing

# 3. Deploy. Bootstrap once per account+region if you never have:
#    npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
echo '{}' > cdk.context.json                    # add {"mfaRequired":true} to enforce MFA
npx cdk deploy --require-approval never

# 4. Read the outputs into variables — no copying by hand.
S=QuickDesktopCognitoProxyStack
get() { aws cloudformation describe-stacks --stack-name $S \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
POOL=$(get PoolId); CLIENT=$(get ClientId); ISSUER=$(get IssuerUrl)
AUTH=$(get AuthEndpoint); TOKEN=$(get TokenEndpoint); JWKS=$(get JwksUri)
printf 'CLIENT %s\nISSUER %s\nAUTH   %s\nTOKEN  %s\nJWKS   %s\n' \
  "$CLIENT" "$ISSUER" "$AUTH" "$TOKEN" "$JWKS"

# 5. Confirm the proxy strips offline_access (expect 302, scope without it).
curl -s -o /dev/null -D - -G "$AUTH" \
  --data-urlencode "client_id=$CLIENT" --data-urlencode "response_type=code" \
  --data-urlencode "redirect_uri=http://localhost:18080" \
  --data-urlencode "scope=openid email profile offline_access" | grep -i '^location:'

# 6. Create users. Add them to IAM Identity Center first, then run the script —
#    it discovers the pool from the stack, shows a plan, and prompts per user.
python3 scripts/sync_users.py --source idc      # or --source local
```

The script needs Python 3.11+ (it imports `StrEnum`), so it will not run on
CloudShell, which ships 3.9. For one or two users the **Cognito console** is the
easier route anyway, and it avoids the invitation email entirely:

**User pools → your pool → Users → Create user**

```
https://<region>.console.aws.amazon.com/cognito/v2/idp/user-pools/<pool-id>/users
```

| Field | Choose |
|---|---|
| Invitation message | **Don't send an invitation** — Cognito's built-in sender is rate-limited and routinely filtered |
| Username | must match the IdC username |
| Email address | must **exactly** match the IdC and Quick email |
| Mark email address as verified | **tick it** — otherwise email-alias sign-in fails |
| Temporary password | **Set a password** rather than auto-generate, so you know it |

That leaves the user in `FORCE_CHANGE_PASSWORD` with a password you chose, which
is all the desktop sign-in needs.

Prefer the script for more than a couple of users: it reads IdC directly, so it
cannot mistype an email — and email is the only thing joining the three systems,
so a typo produces a sign-in that authenticates and then fails to map to a Quick
identity.

Two things the console cannot do. Re-sending an invitation from the script issues
a **new** temporary password, invalidating one you set. And to skip the forced
password change on first login there is no console equivalent:

```bash
aws cognito-idp admin-set-user-password --user-pool-id $POOL \
  --username <username> --password '<Pass123!>' --permanent
```

Then three things no CLI can do:

7. **Quick console** — delete the old **extension**, then the old **extension
   access**; create new ones from the step 4 values. Skipping the delete points
   Quick at dead endpoints.
8. **Sign in to Quick web** in a browser, via Identity Center. The desktop app
   needs an active web session before it will redirect to Cognito.
9. **Desktop app** on the machine where it is installed → *Continue with SSO* →
   sign in at the Cognito page → set a password, enrol an authenticator app.

Confirm it worked — this request only appears after a completed sign-in:

```bash
aws logs filter-log-events --log-group-name /aws/lambda/QuickDesktopAuthProxyFunction \
  --query "events[].message" --output text | grep -c 'POST /oauth2/token'
```

Three rules behind most failures:

- Steps 8 and 9 must be on the **same machine**: `localhost:18080` is machine-local.
- Emails must match exactly across IdC, Cognito and Quick — that is the only join.
- Destroying and redeploying? Delete the retained log group first, or the deploy
  fails with `already exists`:
  `aws logs delete-log-group --log-group-name /aws/lambda/QuickDesktopAuthProxyFunction`

---

## Prerequisites that bite

**Region.** Desktop is unavailable in QuickSight-only regions. Only `us-east-1`,
`us-west-2`, `ap-northeast-1`, `ap-southeast-2`, `eu-central-1`, `eu-west-1`,
`eu-west-2`, `gov-west-1` — the "Agentic Features = Yes" rows of the region
table. **Singapore, Seoul, Mumbai, Jakarta and Malaysia are not supported**, so
an APJ customer wanting desktop must land in Tokyo or Sydney. Enterprise edition
only. The Quick subscription region generally has to match the IdC instance
region unless IdC is replicated multi-region.

The identity region is not discoverable from `describe-account-subscription`,
which answers from any endpoint. This finds it — a wrong region returns
`AccessDeniedException: ... but your identity region is <y>`:

```bash
aws quicksight describe-namespace --aws-account-id $ACCOUNT --namespace default \
  --region us-east-1 --query "Namespace.[Name,CapacityRegion,IdentityStore]" --output text
```

**IdC application assignment.** The Quick app in IdC usually has
`AssignmentRequired: true` and is assigned to **groups**, not individuals — so a
user who exists in the identity store still cannot sign in without group
membership, and this blocks sign-in before Cognito is involved. Note
`--no-paginate`: without it the CLI applies `--query` per page and appends a
literal `None`, so the variable captures two lines and every later command fails
with `Unknown options: None`.

```bash
read -r INSTANCE STORE <<<"$(aws sso-admin list-instances --no-paginate \
  --query "Instances[?OwnerAccountId=='$ACCOUNT'].[InstanceArn,IdentityStoreId]" \
  --output text)"

APP=$(aws sso-admin list-applications --instance-arn "$INSTANCE" --no-paginate \
  --query "Applications[0].ApplicationArn" --output text)
aws sso-admin get-application-assignment-configuration --application-arn "$APP"
aws sso-admin list-application-assignments --application-arn "$APP" --no-paginate
```

Filter on `OwnerAccountId`: `list-instances` also returns instances owned by
other accounts you can see, and the wrong one gives an unrelated directory with
no error.

**Quick web sign-in URL** — read it off the application rather than guessing:

```bash
aws sso-admin describe-application --application-arn "$APP" \
  --query "PortalOptions.SignInOptions.ApplicationUrl" --output text
```

**Two directories, one join key.** The same person exists in IdC *and* Cognito,
linked only by a matching email. IdC authenticates Quick web; Cognito
authenticates the desktop app. First sign-in therefore asks for two different
credentials. That is inherent to this workaround — with a real IdP both hops use
one identity.

---

## The three defects

The first two are fixed in `lib/app.ts` and
`lib/construct-groups/auth-proxy.ts` on this branch. Check any clone with
`grep -c parseCidrs lib/app.ts` and
`grep -c addToLogicalId lib/construct-groups/auth-proxy.ts` — `0` means the fix
is absent. The third is CloudFormation behaviour and has no code fix.

### Bug 1 — `-c allowedCidrs='[...]'` produces a malformed policy

`tryGetContext('allowedCidrs') as string[]` is a compile-time **cast, not a
parse**. Values from `-c key=value` are always strings, so the documented
invocation embeds the raw string into the IAM condition:

```yaml
# WRONG — what the documented flag produces
aws:SourceIp: '["203.0.113.0/24"]'   # a string, not a list
```

That is not a valid CIDR, so the condition cannot match any address. Without the
fix, pass the value via `cdk.context.json` instead, which is parsed as JSON, and
confirm it renders as a list before deploying:

```bash
echo '{"allowedCidrs":["203.0.113.0/24"]}' > cdk.context.json
npx cdk synth | grep -A3 NotIpAddress      # must be a YAML list
```

`mfaRequired` has the same class of bug in reverse: it is only tested for
truthiness, so `-c mfaRequired=false` passes the truthy string `"false"` and MFA
ends up **required**. To disable it, omit the key.

### Bug 2 — policy changes never reach the stage

A REST API resource policy only applies after a **new stage deployment**.
Changing only `allowedCidrs` alters no resource or method, so CDK reuses the
existing deployment and the stage keeps serving the previous policy — while the
console displays the new one. Verified directly: after narrowing an allowlist to
`192.0.2.1/32`, requests from a non-allowlisted address still returned `302`;
only after forcing a deployment did they return `403 ... explicit deny in a
resource-based policy`.

Without the fix, force it after every policy change:

```bash
API=$(aws apigateway get-rest-apis \
  --query "items[?name=='QuickDesktopAuthProxy'].id" --output text)
aws apigateway create-deployment --rest-api-id $API --stage-name prod
```

Allow ~10 s to propagate. **Never conclude an allowlist works by reading the
policy** — given these two bugs, inspection proves nothing. Test by inversion:
allowlist `192.0.2.1/32`, deploy, force a deployment, and confirm your own
request is denied. Then restore and re-test. Beware that tools which look like
they fetch "from the internet" may egress through your own network and give a
false pass.

### Bug 3 — removing `allowedCidrs` does not remove the restriction

The reverse direction does not work at all. Delete `allowedCidrs`, redeploy, and
the policy **stays attached**: CloudFormation leaves an existing API Gateway
policy in place when the property is simply absent from the template. Observed
directly — after removing the flag the API still enforced the previous CIDRs. So
the stack can restrict an API but cannot un-restrict one. Clear it explicitly:

```bash
aws apigateway update-rest-api --rest-api-id $API \
  --patch-operations op=replace,path=/policy,value=''
aws apigateway create-deployment --rest-api-id $API --stage-name prod
aws apigateway get-rest-api --rest-api-id $API --query policy --output text  # None = gone
```

Related: `cdk.context.json` is gitignored and survives teardown, so a "fresh"
deploy silently reapplies whatever allowlist it still holds. Check the file
before deploying, not after wondering why requests are denied. Out-of-band CLI
changes drift the same way — CloudFormation only applies template *changes*, so
a pool setting altered by CLI is not corrected by a redeploy, but will snap back
the moment any other property on that resource changes.

### Which IP to allowlist, if you use one

Three different egress paths are involved and they differ:

| Who calls what | Which egress applies |
|---|---|
| Browser → `GET /oauth2/authorize` | the **browser's** |
| Desktop app → `POST /oauth2/token` | the **app process's** |
| Your terminal running `curl` | irrelevant unless it happens to match |

A proxying browser extension makes these genuinely differ — `curl` reporting one
address while the browser exits from another, with `scutil --proxy` empty so
nothing hints at it. Allowlist the wrong one and `curl` passes while the browser
gets `403`. Always measure in the **browser on the machine running the desktop
app**. Corporate pools rotate, so any address obtained this way is temporary; if
you find yourself adding IPs twice, deploy open for the demo instead.

---

## Manual steps in detail

**Quick console** — no API exists. Verified against a current CLI: the only
identity-related QuickSight operations are the `identity-propagation-config`
family, which is for data sources, not the desktop OIDC extension. Create
extension access from the five stack outputs, then create the extension from it.
When replacing a deployment, delete the **extension first**, then the
**extension access**.

Only two of the five values point at your proxy:

| Quick field | Stack output | Destination |
|---|---|---|
| Client ID / aud claim | `ClientId` | identifier only |
| Issuer URL | `IssuerUrl` | Cognito, direct |
| Authorization endpoint | `AuthEndpoint` | **your API Gateway** |
| Token endpoint | `TokenEndpoint` | **your API Gateway** |
| JWKS URI | `JwksUri` | Cognito, direct |

Because the issuer stays `cognito-idp.<region>.amazonaws.com/<poolId>`, the
tokens are ordinary Cognito tokens and nothing downstream knows a proxy exists.

**The callback is machine-local.** The redirect target is
`http://localhost:18080`, which resolves only on the machine running the app.
Complete the login in a browser on that same machine, or the code is delivered to
a loopback address where nothing is listening:

```
http://localhost:18080/?code=...&state=...
ERR_CONNECTION_REFUSED
```

The app also binds that port **only during an active sign-in**, so a callback URL
reloaded from history, or a flow left idle, arrives after the listener is gone.
Codes are single-use and expire in about five minutes — restart from inside the
app rather than retrying the URL. `netstat`/`lsof` showing nothing on 18080 while
idle is normal; check during a sign-in.

**userInfo.** The proxy forwards `/oauth2/userInfo` (and `/oauth2/userinfo`)
because the extension configuration has no userInfo field, so a client that does
not read the issuer's discovery document can only derive it from the token
endpoint — which points at the proxy. Cognito's userInfo accepts **only the
access token**; an ID token returns `401 invalid_token`. Verified working: a real
access token returns `200` with `sub`, `email`, `email_verified` and `username`.

**Production gaps.** The pool uses Cognito's built-in email sender, which is
rate-limited and meant for testing — configure SES. The sync script is a one-shot
copy that never detects deletions, so a departing employee's pool account
outlives their identity until someone intervenes; wrap `CognitoUserSyncer` in a
scheduled Lambda or drive it from SCIM.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403` explicit deny at authorize | Egress IP not allowlisted. Measure it **in the browser on the machine running the app**. |
| `curl` passes but the browser gets `403` | Browser and shell egress differ — typically a proxying browser extension. |
| Authorize works, then sign-in stalls | `POST /oauth2/token` comes from the **app process**, whose egress may differ. Allowlist both. |
| `403` right after a deploy, then fine | Stage deployment propagation, ~10 s. |
| Allowlist set but everyone gets through | Bug 2 — no new stage deployment. |
| Requests denied although `allowedCidrs` was removed | Bug 3 — the policy survives. Clear it explicitly. |
| A "fresh" deploy is unexpectedly IP-restricted | `cdk.context.json` survived teardown. |
| Policy looks malformed in the template | Bug 1 — `-c allowedCidrs` was used. |
| `ERR_CONNECTION_REFUSED` on `localhost:18080` | Browser is not on the machine running the app, or the listener already closed. |
| `netstat`/`lsof` shows nothing on 18080 | Normal when idle; only meaningful during a sign-in. |
| "Incorrect username or password" at the hosted UI | Usually the invitation email never arrived, or the password is from a pool that no longer exists. Create the user in the Cognito console with a password you set, and tick "Mark email address as verified". |
| "User info request failed (HTTP 401)" after a successful token exchange | The client presented something other than the access token. Cognito's userInfo rejects ID tokens. |
| Browser opens Quick sign-in instead of Cognito | No active Quick web session — do step 8 first. |
| Cannot sign in to Quick web at all | IdC `AssignmentRequired: true` and the user is in no assigned group. |
| Sign-in succeeds but no Quick session | Email mismatch between the Cognito user and the Quick user. |
| `ResourceNotFoundException ... not signed up with QuickSight` | Subscription missing or `UNSUBSCRIBED`. |
| Scope error at authorize | The proxy is not in the path — the console points at Cognito directly. |
| MFA required when you did not want it | `-c mfaRequired=false` is truthy. Omit the key. |
| Deploy fails `AWS::Logs::LogGroup ... already exists` | The retained log group from a previous deploy. Delete it. |
| CloudShell `ENOSPC` during `npm install` | npm caches in the quota'd `$HOME`. Set `npm_config_cache=/tmp/npm-cache` and work on `/tmp`. |

The Lambda logs every request and response, which is the fastest diagnostic:

```bash
aws logs tail /aws/lambda/QuickDesktopAuthProxyFunction --follow
```

---

## Teardown and redeploy

A redeploy creates a **new pool and a new API**, so every value you configured
by hand becomes invalid: pool ID, client ID, issuer, JWKS and both endpoints all
change, and the users are gone. You must delete and recreate the Quick extension
access and extension, and re-run the sync. Budget for that, not just
`cdk destroy`. The hosted UI domain is derived from account and region, so it is
the one value that stays identical. CDK bootstrap is reusable — do not delete it.

If you only need to change the allowlist or MFA, do **not** destroy: edit
`cdk.context.json`, deploy, and force a stage deployment.

```bash
npx cdk destroy --force

# Two things deliberately survive and will block the next deploy.
# The Lambda log group is created with DeletionPolicy: Retain.
aws logs delete-log-group --log-group-name /aws/lambda/QuickDesktopAuthProxyFunction

# With -c retain=true, the pool and its hosted UI domain also survive. The domain
# prefix is quick-desktop-<account>-<region>, so it collides on redeploy.
aws cognito-idp delete-user-pool-domain \
  --domain quick-desktop-<account>-<region> --user-pool-id <pool-id>
aws cognito-idp delete-user-pool --user-pool-id <pool-id>
```

Verify before redeploying — all three must be `0`, and the domain must no longer
resolve:

```bash
aws cognito-idp list-user-pools --max-results 20 \
  --query "UserPools[?Name=='QuickDesktopUserPool'] | length(@)"
aws apigateway get-rest-apis --query "items[?name=='QuickDesktopAuthProxy'] | length(@)"
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/QuickDesktop \
  --query 'length(logGroups)'
```

Then delete the extension and extension access in the Quick console, in that
order. Remove the stack once the demo is done rather than leaving an
internet-facing endpoint parked in the account.

The same domain-prefix determinism means you cannot run two of these stacks in
one account and region without editing `CognitoDomainPrefix` in
`lib/common/config.ts`.
