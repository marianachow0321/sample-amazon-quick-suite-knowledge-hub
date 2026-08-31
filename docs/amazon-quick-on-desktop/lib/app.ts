#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { CognitoProxyStack } from './stacks/cognito-proxy-stack';
import { ProjectName, QuickDesktopConfig, createStackName } from './common/config';

const region = process.env.CDK_DEFAULT_REGION || 'us-east-1';

const app = new App();

/**
 * Context values supplied via `-c key=value` on the CLI always arrive as
 * strings, while values in `cdk.json` / `cdk.context.json` arrive as parsed
 * JSON. Both must be handled: casting a string to `string[]` compiles but
 * embeds the raw string in the IAM policy, producing a condition that cannot
 * match any address.
 */
const parseCidrs = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  let cidrs: unknown;
  if (Array.isArray(value)) {
    cidrs = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    cidrs = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split(',');
  } else {
    throw new Error(`allowedCidrs must be a list or JSON array, received: ${typeof value}`);
  }

  if (!Array.isArray(cidrs)) {
    throw new Error(`allowedCidrs must resolve to a list, received: ${JSON.stringify(cidrs)}`);
  }

  const parsed = cidrs.map((cidr) => String(cidr).trim()).filter((cidr) => cidr.length > 0);
  if (parsed.length === 0) {
    return undefined;
  }

  // Fail at synth rather than deploying a policy that silently denies everyone.
  const cidrPattern = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
  const invalid = parsed.filter((cidr) => !cidrPattern.test(cidr));
  if (invalid.length > 0) {
    throw new Error(
      `allowedCidrs contains entries that are not IPv4 CIDR blocks: ${invalid.join(', ')}. ` +
        'Expected e.g. ["203.0.113.0/24"]. A single address needs a /32 suffix.',
    );
  }

  return parsed;
};

/** `-c flag=false` arrives as the string "false", which is truthy. */
const parseBoolean = (value: unknown): boolean | undefined =>
  value === undefined ? undefined : typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true';

const retainResources = parseBoolean(app.node.tryGetContext('retain')) ?? false;
const allowedCidrs = parseCidrs(app.node.tryGetContext('allowedCidrs'));
const mfaRequired = parseBoolean(app.node.tryGetContext('mfaRequired'));

const config: QuickDesktopConfig = {
  projectName: ProjectName.QUICK_DESKTOP,
  retainResources,
  ...(allowedCidrs && { allowedCidrs }),
  ...(mfaRequired !== undefined && { mfaRequired }),
};

new CognitoProxyStack(app, createStackName(config.projectName, 'CognitoProxy'), {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});

app.synth();
