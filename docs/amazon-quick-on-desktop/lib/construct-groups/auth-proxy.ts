import { Duration } from 'aws-cdk-lib';
import { Function as LambdaFunction, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { RestApi, LambdaIntegration } from 'aws-cdk-lib/aws-apigateway';
import { PolicyDocument, PolicyStatement, Effect, AnyPrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { join } from 'path';
import { ProjectName, ResourceName, createConstructId, createResourceName } from '../common/config';

export interface AuthProxyProps {
  readonly projectName: ProjectName;
  readonly cognitoDomain: string;
  readonly allowedCidrs?: string[];
}

export class AuthProxy extends Construct {
  public readonly api: RestApi;

  constructor(scope: Construct, id: string, props: AuthProxyProps) {
    super(scope, id);

    const { projectName, cognitoDomain, allowedCidrs } = props;

    const fn = new LambdaFunction(this, createConstructId('Function'), {
      functionName: createResourceName(projectName, ResourceName.AUTH_PROXY_FUNCTION),
      runtime: Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: Code.fromAsset(join(__dirname, '..', '..', 'lambda')),
      timeout: Duration.seconds(10),
      environment: { COGNITO_DOMAIN: cognitoDomain },
    });

    const integration = new LambdaIntegration(fn);

    const policy = allowedCidrs ? this.createResourcePolicy(allowedCidrs) : undefined;

    this.api = new RestApi(this, createConstructId('Api'), {
      restApiName: createResourceName(projectName, ResourceName.AUTH_PROXY_API),
      deployOptions: { stageName: 'prod' },
      ...(policy && { policy }),
    });

    const oauth2 = this.api.root.addResource('oauth2');
    const authorize = oauth2.addResource('authorize');
    const token = oauth2.addResource('token');

    authorize.addMethod('GET', integration);
    token.addMethod('POST', integration);

    // The Amazon Quick extension configuration has no userInfo field, so a
    // client that does not read the issuer's discovery document may derive the
    // endpoint from the token endpoint it was given — which points at this API,
    // not at Cognito. Without these routes API Gateway rejects the request
    // before it reaches the Lambda and sign-in fails after a successful token
    // exchange. Both casings are registered because API Gateway path parts are
    // case-sensitive and clients differ; Cognito itself advertises `userInfo`.
    for (const name of ['userInfo', 'userinfo']) {
      const userInfo = oauth2.addResource(name);
      userInfo.addMethod('GET', integration);
      userInfo.addMethod('POST', integration);
    }

    // A REST API resource policy only takes effect once the stage is
    // redeployed. Changing only `allowedCidrs` does not alter any resource or
    // method, so CDK would reuse the existing deployment and the new policy
    // would never reach the stage: the API keeps serving under the old policy
    // while the console shows the new one. Mixing the policy into the
    // deployment's logical ID forces a fresh deployment whenever it changes,
    // including when the restriction is removed.
    this.api.latestDeployment?.addToLogicalId({
      resourcePolicyAllowedCidrs: allowedCidrs ?? null,
    });
  }

  private createResourcePolicy(allowedCidrs: string[]): PolicyDocument {
    return new PolicyDocument({
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          principals: [new AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*/*/*'],
        }),
        new PolicyStatement({
          effect: Effect.DENY,
          principals: [new AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*/*/*'],
          conditions: {
            NotIpAddress: { 'aws:SourceIp': allowedCidrs },
          },
        }),
      ],
    });
  }
}
