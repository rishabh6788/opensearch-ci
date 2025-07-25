/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 */

import {
  CfnOutput, CfnParameter, Fn, Stack, StackProps,
} from 'aws-cdk-lib';
import {
  FlowLogDestination, FlowLogTrafficType, IPeer, Peer, Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { ListenerCertificate } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { CiAuditLogging } from './auditing/ci-audit-logging';
import { CIConfigStack } from './ci-config-stack';
import { AgentNodeProps } from './compute/agent-node-config';
import { AgentNodes } from './compute/agent-nodes';
import { FineGrainedAccessSpecs } from './compute/auth-config';
import { JenkinsMainNode } from './compute/jenkins-main-node';
import { RunAdditionalCommands } from './compute/run-additional-commands';
import { JenkinsMonitoring } from './monitoring/ci-alarms';
import { JenkinsExternalLoadBalancer } from './network/ci-external-load-balancer';
import { JenkinsSecurityGroups } from './security/ci-security-groups';
import { JenkinsWAF } from './security/waf';
import { AWSSecretsJenkinsCredentials } from './secrets/secret-credentials';

enum DeploymentType {
  BTR = 'BTR', // Build Test Release
  GRADLE = 'gradle',
  BENCHMARK = 'benchmark',
  DEFAULT = 'default',
}

export interface CIStackProps extends StackProps {
  /** Should the Jenkins use https  */
  readonly useSsl?: boolean;
  /** Type of login mechanism to adopt */
  readonly authType?: string;
  /** Restrict jenkins access to */
  readonly restrictServerAccessTo?: IPeer;
  /** Additional verification during deployment and resource startup. */
  readonly ignoreResourcesFailures?: boolean;
  /** Users with admin access during initial deployment */
  readonly adminUsers?: string[];
  /** Additional logic that needs to be run on Master Node. The value has to be path to a file */
  readonly additionalCommands?: string;
  /** Do you want to retain jenkins jobs and build history */
  readonly dataRetention?: boolean;
  /** IAM role ARN to be assumed by jenkins agent nodes eg: cross-account */
  readonly agentAssumeRole?: string[];
  /** File path containing global environment variables to be added to jenkins enviornment */
  readonly envVarsFilePath?: string;
  /** Add Mac agent to jenkins */
  readonly macAgent?: boolean;
  /** Enable views on jenkins UI */
  readonly enableViews?: boolean;
  /** Use Production Agents */
  readonly useProdAgents?: boolean;
  /** Specify jenkins instance type */
  readonly jenkinsInstanceType?: string | DeploymentType;
  /** Fine grain access control specifications */
  readonly fineGrainedAccessSpecs?: FineGrainedAccessSpecs[];
  /** Alternative agent node configurations */
  readonly alternativeNodeConfig?: AgentNodeProps[];
}

function getServerAccess(serverAccessType: string, restrictServerAccessTo: string): IPeer {
  if (typeof restrictServerAccessTo === 'undefined') {
    throw new Error('restrictServerAccessTo should be specified');
  }
  switch (serverAccessType) {
  case 'ipv4':
    return restrictServerAccessTo === 'all' ? Peer.anyIpv4() : Peer.ipv4(restrictServerAccessTo);
  case 'ipv6':
    return restrictServerAccessTo === 'all' ? Peer.anyIpv6() : Peer.ipv6(restrictServerAccessTo);
  case 'prefixList':
    return Peer.prefixList(restrictServerAccessTo);
  case 'securityGroupId':
    return Peer.securityGroupId(restrictServerAccessTo);
  default:
    throw new Error('serverAccessType should be one of the below values: ipv4, ipv6, prefixList or  securityGroupId');
  }
}

export class CIStack extends Stack {
  public readonly monitoring: JenkinsMonitoring;

  public readonly agentNodes: AgentNodeProps[];

  public readonly securityGroups: JenkinsSecurityGroups;

  constructor(scope: Construct, id: string, props: CIStackProps) {
    super(scope, id, props);

    const auditloggingS3Bucket = new CiAuditLogging(this);
    const vpc = new Vpc(this, 'JenkinsVPC', {
      flowLogs: {
        cloudwatch: {
          destination: FlowLogDestination.toCloudWatchLogs(
            new LogGroup(this, 'VPCFlowLogs', {
              logGroupName: 'Jenkins/vpc/flow-logs',
            }),
          ),
          trafficType: FlowLogTrafficType.ALL,
        },
      },
    });

    const macAgentParameter = `${props?.macAgent ?? this.node.tryGetContext('macAgent')}`;

    const useSslParameter = `${props?.useSsl ?? this.node.tryGetContext('useSsl')}`;
    if (useSslParameter !== 'true' && useSslParameter !== 'false') {
      throw new Error('useSsl parameter is required to be set as - true or false');
    }

    const useSsl = useSslParameter === 'true';

    let authType = `${props?.authType ?? this.node.tryGetContext('authType')}`;
    if (authType.toString() === 'undefined') {
      authType = 'default';
    }
    if (authType !== 'default' && authType !== 'github' && authType !== 'oidc') {
      throw new Error('authType parameter is required to be set as - default, github or oidc');
    }

    let useProdAgents = `${props?.useProdAgents ?? this.node.tryGetContext('useProdAgents')}`;
    if (useProdAgents.toString() === 'undefined') {
      useProdAgents = 'false';
    }

    let jenkinsInstanceType: string | DeploymentType = `${props?.jenkinsInstanceType ?? this.node.tryGetContext('jenkinsInstanceType')}`;
    if (jenkinsInstanceType.toString() === 'undefined') {
      jenkinsInstanceType = useProdAgents.toString() === 'true' ? DeploymentType.BTR : DeploymentType.DEFAULT;
    } else if (!Object.values(DeploymentType).includes(jenkinsInstanceType as DeploymentType)) {
      throw new Error(`Invalid jenkinsInstanceType value: ${jenkinsInstanceType}`);
    }

    const serverAccessType = this.node.tryGetContext('serverAccessType');
    const restrictServerAccessTo = this.node.tryGetContext('restrictServerAccessTo');
    const serverAcess = props?.restrictServerAccessTo ?? getServerAccess(serverAccessType, restrictServerAccessTo);
    if (!serverAcess) {
      throw new Error('serverAccessType and restrictServerAccessTo parameters are required - eg: serverAccessType=ipv4 restrictServerAccessTo=10.10.10.10/32');
    }

    const additionalCommandsContext = `${props?.additionalCommands ?? this.node.tryGetContext('additionalCommands')}`;

    // Setting CfnParameters to record the value in cloudFormation
    new CfnParameter(this, 'authType', {
      description: 'Auth type for jenkins login',
      default: authType,
    });

    // Setting CfnParameters to record the value in cloudFormation
    new CfnParameter(this, 'useSsl', {
      description: 'If the jenkins instance should be access via SSL',
      default: useSsl,
    });

    this.securityGroups = new JenkinsSecurityGroups(this, vpc, useSsl, serverAcess);
    const importedContentsSecretBucketValue = Fn.importValue(`${CIConfigStack.CERTIFICATE_CONTENTS_SECRET_EXPORT_VALUE}`);
    const importedContentsChainBucketValue = Fn.importValue(`${CIConfigStack.CERTIFICATE_CHAIN_SECRET_EXPORT_VALUE}`);
    const importedCertSecretBucketValue = Fn.importValue(`${CIConfigStack.PRIVATE_KEY_SECRET_EXPORT_VALUE}`);
    const importedArnSecretBucketValue = Fn.importValue(`${CIConfigStack.CERTIFICATE_ARN_SECRET_EXPORT_VALUE}`);
    const importedRedirectUrlSecretBucketValue = Fn.importValue(`${CIConfigStack.REDIRECT_URL_SECRET_EXPORT_VALUE}`);
    const importedAuthConfigValuesSecretBucketValue = Fn.importValue(`${CIConfigStack.AUTH_CONFIGURATION_VALUE_SECRET_EXPORT_VALUE}`);
    const certificateArn = Secret.fromSecretCompleteArn(this, 'certificateArn', importedArnSecretBucketValue.toString());
    const importedReloadPasswordSecretsArn = Fn.importValue(`${CIConfigStack.CASC_RELOAD_TOKEN_SECRET_EXPORT_VALUE}`);
    const listenerCertificate = ListenerCertificate.fromArn(certificateArn.secretValue.toString());
    const agentNode = new AgentNodes(this);

    if (useProdAgents.toString() === 'true') {
      // eslint-disable-next-line no-console
      console.warn('Please note that if you have decided to use the provided production jenkins agents then '
        + 'please make sure that you are deploying the stack in US-EAST-1 region as the AMIs used are only publicly '
        + 'available in US-EAST-1 region. '
        + 'If you want to deploy the stack in another region then please make sure you copy the public AMIs used '
        + 'from us-east-1 region to your region of choice and update the ami-id in agent-nodes.ts file accordingly. '
        + 'If you do not copy the AMI in required region and update the code then the jenkins agents will not spin up.');
    }

    this.agentNodes = props.alternativeNodeConfig ?? agentNode.getRequiredAgentNodes(jenkinsInstanceType.toString());

    const mainJenkinsNode = new JenkinsMainNode(this, {
      vpc,
      sg: this.securityGroups.mainNodeSG,
      efsSG: this.securityGroups.efsSG,
      dataRetention: props.dataRetention ?? false,
      envVarsFilePath: props.envVarsFilePath ?? '',
      enableViews: props.enableViews ?? false,
      reloadPasswordSecretsArn: importedReloadPasswordSecretsArn.toString(),
      sslCertContentsArn: importedContentsSecretBucketValue.toString(),
      sslCertChainArn: importedContentsChainBucketValue.toString(),
      sslCertPrivateKeyContentsArn: importedCertSecretBucketValue.toString(),
      redirectUrlArn: importedRedirectUrlSecretBucketValue.toString(),
      authCredsSecretsArn: importedAuthConfigValuesSecretBucketValue.toString(),
      useSsl,
      authType,
      fineGrainedAccessSpecs: props?.fineGrainedAccessSpecs,
      failOnCloudInitError: props?.ignoreResourcesFailures,
      adminUsers: props?.adminUsers,
      agentNodeSecurityGroup: this.securityGroups.agentNodeSG.securityGroupId,
      subnetId: vpc.privateSubnets[0].subnetId,
    }, this.agentNodes, macAgentParameter.toString(), props?.agentAssumeRole);

    const externalLoadBalancer = new JenkinsExternalLoadBalancer(this, {
      vpc,
      sg: this.securityGroups.externalAccessSG,
      targetInstance: mainJenkinsNode.mainNodeAsg,
      listenerCertificate,
      useSsl,
      accessLogBucket: auditloggingS3Bucket.bucket,
    });

    const waf = new JenkinsWAF(this, {
      loadBalancer: externalLoadBalancer.loadBalancer,
    });

    const artifactBucket = new Bucket(this, 'BuildBucket');

    new AWSSecretsJenkinsCredentials(this);

    this.monitoring = new JenkinsMonitoring(this, externalLoadBalancer, mainJenkinsNode);

    if (additionalCommandsContext.toString() !== 'undefined') {
      new RunAdditionalCommands(this, additionalCommandsContext.toString());
    }

    new CfnOutput(this, 'Artifact Bucket Arn', {
      value: artifactBucket.bucketArn.toString(),
      exportName: 'buildBucketArn',
    });
  }
}
