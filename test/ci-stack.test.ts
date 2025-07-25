/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 */

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Peer } from 'aws-cdk-lib/aws-ec2';
import { Effect } from 'aws-cdk-lib/aws-iam';
import { CIStack } from '../lib/ci-stack';
import { AgentNodes } from '../lib/compute/agent-nodes';

test('CI Stack Basic Resources', () => {
  const app = new App({
    context: {
      useSsl: 'true',
      serverAccessType: 'ipv4',
      restrictServerAccessTo: '10.10.10.10/32',
      additionalCommands: './test/data/hello-world.py',
      jenkinsInstanceType: 'BTR',
      useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'TestStack', {
    dataRetention: true,
    env: { account: 'test-account', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);

  // THEN
  template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  template.resourceCountIs('AWS::AutoScaling::LaunchConfiguration', 1);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  template.resourceCountIs('AWS::EC2::SecurityGroup', 4);
  template.resourceCountIs('AWS::IAM::Policy', 36);
  template.resourceCountIs('AWS::IAM::Role', 37);
  template.resourceCountIs('AWS::S3::Bucket', 2);
  template.resourceCountIs('AWS::EC2::KeyPair', 1);
  template.resourceCountIs('AWS::IAM::InstanceProfile', 2);
  template.resourceCountIs('AWS::SSM::Document', 1);
  template.resourceCountIs('AWS::SSM::Association', 1);
  template.resourceCountIs('AWS::EFS::FileSystem', 1);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  template.resourceCountIs('AWS::SecretsManager::Secret', 4);

  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringLike: {
              'token.actions.githubusercontent.com:sub': 'repo:opensearch-project/opensearch-jvector:ref:refs/*',
            },
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            },
          },
          Effect: 'Allow',
          Principal: {
            Federated: 'arn:aws:iam::test-account:oidc-provider/token.actions.githubusercontent.com',
          },
        }),

      ],
      Version: '2012-10-17',
    },
    RoleName: 'opensearch-jvector-secret-access-role-for-branches-public',
  });
});

test('External security group is open', () => {
  const app = new App({
    context: {
      useSsl: 'true', serverAccessType: 'ipv4', restrictServerAccessTo: 'all', jenkinsInstanceType: 'BTR', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', { env: { account: 'test-account', region: 'us-east-1' }, useProdAgents: false });
  const template = Template.fromStack(stack);

  // THEN
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'External access to Jenkins',
    SecurityGroupEgress: [
      {
        CidrIp: '0.0.0.0/0',
        Description: 'Allow all outbound traffic by default',
        IpProtocol: '-1',
      },
    ],
  });

  // Make sure that `open` is false on all the load balancers
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: [
      {
        CidrIp: '0.0.0.0/0',
        Description: 'Restrict jenkins endpoint access to this source',
        FromPort: 443,
        IpProtocol: 'tcp',
        ToPort: 443,
      },
      {
        CidrIp: '0.0.0.0/0',
        Description: 'Allow from anyone on port 80',
        FromPort: 80,
        IpProtocol: 'tcp',
        ToPort: 80,
      },
    ],
  });
});

test('External security group is restricted', () => {
  const app = new App({
    context: {
      useSsl: 'true', serverAccessType: 'ipv4', restrictServerAccessTo: '10.0.0.0/24', useProdAgents: 'true',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
    useSsl: true,
    restrictServerAccessTo: Peer.ipv4('10.0.0.0/24'),
    useProdAgents: true,
  });
  const template = Template.fromStack(stack);

  // THEN
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'External access to Jenkins',
    SecurityGroupEgress: [
      {
        CidrIp: '0.0.0.0/0',
      },
    ],
  });

  // Make sure that load balancer access is restricted to given Ipeer
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: [
      {
        CidrIp: '10.0.0.0/24',
        Description: 'Restrict jenkins endpoint access to this source',
        FromPort: 443,
        IpProtocol: 'tcp',
        ToPort: 443,
      },
      {
        CidrIp: '0.0.0.0/0',
        Description: 'Allow from anyone on port 80',
        FromPort: 80,
        IpProtocol: 'tcp',
        ToPort: 80,
      },
    ],
  });
});

test('MainNode', () => {
  const app = new App({
    context: {
      useSsl: 'true', authType: 'oidc', serverAccessType: 'ipv4', restrictServerAccessTo: '10.10.10.10/32', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::AutoScaling::LaunchConfiguration', {
    InstanceType: 'c5.9xlarge',
    SecurityGroups: [
      {
        'Fn::GetAtt': [
          'MainNodeSG5CEF04F0',
          'GroupId',
        ],
      },
    ],
  });

  Template.fromStack(stack).hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MaxSize: '1',
    MinSize: '1',
    DesiredCapacity: '1',
  });
});

test('LoadBalancer', () => {
  const app = new App({
    context: {
      useSsl: 'true', authType: 'oidc', serverAccessType: 'ipv4', restrictServerAccessTo: 'all', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    SecurityGroups: [
      {
        'Fn::GetAtt': [
          'ExternalAccessSGFD03F4DC',
          'GroupId',
        ],
      },
    ],
  });
});

test('CloudwatchCpuAlarm', () => {
  const app = new App({
    context: {
      useSsl: 'false', serverAccessType: 'ipv4', restrictServerAccessTo: '10.10.10.10/32', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'CPUUtilization',
    Statistic: 'Average',
  });
});

test('CloudwatchMemoryAlarm', () => {
  const app = new App({
    context: {
      useSsl: 'false', serverAccessType: 'ipv4', restrictServerAccessTo: '10.10.10.10/32', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'mem_used_percent',
    Statistic: 'Average',
  });
});

test('LoadBalancer Access Logging', () => {
  const app = new App({
    context: {
      useSsl: 'false', serverAccessType: 'ipv4', restrictServerAccessTo: '10.10.10.10/32', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    LoadBalancerAttributes: [
      {
        Key: 'deletion_protection.enabled',
        Value: 'false',
      },
      {
        Key: 'access_logs.s3.enabled',
        Value: 'true',
      },
      {
        Key: 'access_logs.s3.bucket',
        Value: {
          Ref: 'jenkinsAuditBucket110D3080',
        },
      },
      {
        Key: 'access_logs.s3.prefix',
        Value: 'loadBalancerAccessLogs',
      },
    ],
  });

  Template.fromStack(stack).hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: [
        {
          Action: 's3:PutObject',
          Effect: 'Allow',
          Principal: {
            AWS: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  {
                    Ref: 'AWS::Partition',
                  },
                  ':iam::127311923021:root',
                ],
              ],
            },
          },
          Resource: {
            'Fn::Join': [
              '',
              [
                {
                  'Fn::GetAtt': [
                    'jenkinsAuditBucket110D3080',
                    'Arn',
                  ],
                },
                '/loadBalancerAccessLogs/AWSLogs/test-account/*',
              ],
            ],
          },
        },
        {
          Action: 's3:PutObject',
          Condition: {
            StringEquals: {
              's3:x-amz-acl': 'bucket-owner-full-control',
            },
          },
          Effect: 'Allow',
          Principal: {
            Service: 'delivery.logs.amazonaws.com',
          },
          Resource: {
            'Fn::Join': [
              '',
              [
                {
                  'Fn::GetAtt': [
                    'jenkinsAuditBucket110D3080',
                    'Arn',
                  ],
                },
                '/loadBalancerAccessLogs/AWSLogs/test-account/*',
              ],
            ],
          },
        },
        {
          Action: 's3:GetBucketAcl',
          Effect: 'Allow',
          Principal: {
            Service: 'delivery.logs.amazonaws.com',
          },
          Resource: {
            'Fn::GetAtt': [
              'jenkinsAuditBucket110D3080',
              'Arn',
            ],
          },
        },
        {
          Action: 's3:PutObject',
          Effect: 'Allow',
          Principal: {
            Service: 'logdelivery.elasticloadbalancing.amazonaws.com',
          },
          Resource: {
            'Fn::Join': [
              '',
              [
                {
                  'Fn::GetAtt': [
                    'jenkinsAuditBucket110D3080',
                    'Arn',
                  ],
                },
                '/loadBalancerAccessLogs/*',
              ],
            ],
          },
        },
      ],
      Version: '2012-10-17',
    },
  });
});

describe('AgentNodes', () => {
  let agentNodes: AgentNodes;
  const app = new App({
    context: {
      useSsl: 'false', run: 'false', serverAccessType: 'ipv4', restrictServerAccessTo: '10.10.10.10/32', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  beforeEach(() => {
    agentNodes = new AgentNodes(stack);
  });

  it('should exclude "default" keys when type is "BTR"', () => {
    const result = agentNodes.getRequiredAgentNodes('BTR');
    expect(result.length).toBe(15);
  });

  it('should return keys containing "benchmark" when type is "benchmark"', () => {
    const result = agentNodes.getRequiredAgentNodes('benchmark');
    expect(result).toHaveLength(2);
  });

  it('should return keys containing "gradle" when type is "gradle"', () => {
    const result = agentNodes.getRequiredAgentNodes('gradle');
    expect(result).toHaveLength(2);
  });

  it('should return keys containing "default" when type is "default"', () => {
    const result = agentNodes.getRequiredAgentNodes('default');
    expect(result).toHaveLength(2);
  });
});

test('WAF rules', () => {
  const app = new App({
    context: {
      useSsl: 'false', serverAccessType: 'ipv4', restrictServerAccessTo: '0.0.0.0/0', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::WAFv2::WebACL', {
    DefaultAction: {
      Allow: {},
    },
    Scope: 'REGIONAL',
    VisibilityConfig: {
      CloudWatchMetricsEnabled: true,
      MetricName: 'jenkins-WAF',
      SampledRequestsEnabled: true,
    },
    Name: 'jenkins-WAF',
    Rules: [
      {
        Name: 'AllowGitHubIPv4',
        Priority: 0,
        Statement: {
          IPSetReferenceStatement:
          {
            Arn: {
              'Fn::GetAtt': [
                'GitHubIpv4Set',
                'Arn',
              ],
            },
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'AllowGitHubIPv4',
          SampledRequestsEnabled: true,
        },
      },
      {
        Name: 'AllowGitHubIPv6',
        Priority: 1,
        Statement: {
          IPSetReferenceStatement:
          {
            Arn: {
              'Fn::GetAtt': [
                'GitHubIpv6Set',
                'Arn',
              ],
            },
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'AllowGitHubIPv6',
          SampledRequestsEnabled: true,
        },
      },
      {
        Name: 'AWS-AWSManagedRulesCommonRuleSet',
        OverrideAction: {
          None: {},
        },
        Priority: 2,
        Statement: {
          ManagedRuleGroupStatement: {
            Name: 'AWSManagedRulesCommonRuleSet',
            VendorName: 'AWS',
            RuleActionOverrides: [
              {
                Name: 'SizeRestrictions_BODY',
                ActionToUse: {
                  Allow: {},
                },
              },
            ],
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'AWS-AWSManagedRulesCommonRuleSet',
          SampledRequestsEnabled: true,
        },
      },
      {
        Name: 'AWS-AWSManagedRulesAmazonIpReputationList',
        OverrideAction: {
          None: {},
        },
        Priority: 3,
        Statement: {
          ManagedRuleGroupStatement: {
            Name: 'AWSManagedRulesAmazonIpReputationList',
            VendorName: 'AWS',
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'AWSManagedRulesAmazonIpReputationList',
          SampledRequestsEnabled: true,
        },
      },
      {
        Name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
        OverrideAction: {
          None: {},
        },
        Priority: 4,
        Statement: {
          ManagedRuleGroupStatement: {
            ExcludedRules: [],
            Name: 'AWSManagedRulesKnownBadInputsRuleSet',
            VendorName: 'AWS',
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
          SampledRequestsEnabled: true,
        },
      },
      {
        Name: 'AWS-AWSManagedRulesSQLiRuleSet',
        OverrideAction: {
          None: {},
        },
        Priority: 5,
        Statement: {
          ManagedRuleGroupStatement: {
            ExcludedRules: [],
            Name: 'AWSManagedRulesSQLiRuleSet',
            VendorName: 'AWS',
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'AWS-AWSManagedRulesSQLiRuleSet',
          SampledRequestsEnabled: true,
        },
      },
      {
        Name: 'AWS-AWSManagedRulesWordPressRuleSet',
        OverrideAction: {
          None: {},
        },
        Priority: 6,
        Statement: {
          ManagedRuleGroupStatement: {
            ExcludedRules: [],
            Name: 'AWSManagedRulesWordPressRuleSet',
            VendorName: 'AWS',
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'AWS-AWSManagedRulesWordPressRuleSet',
          SampledRequestsEnabled: true,
        },
      },
      {
        Name: 'AWS-AWSManagedRulesAnonymousIpList',
        OverrideAction: {
          None: {},
        },
        Priority: 7,
        Statement: {
          ManagedRuleGroupStatement: {
            ExcludedRules: [],
            Name: 'AWSManagedRulesAnonymousIpList',
            VendorName: 'AWS',
          },
        },
        VisibilityConfig: {
          CloudWatchMetricsEnabled: true,
          MetricName: 'AWS-AWSManagedRulesAnonymousIpList',
          SampledRequestsEnabled: true,
        },
      },
    ],
  });
});

test('Test WAF association with ALB', () => {
  const app = new App({
    context: {
      useSsl: 'false', serverAccessType: 'ipv4', restrictServerAccessTo: '0.0.0.0/0', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
    ResourceArn: {
      Ref: 'JenkinsALB9F3D5428',
    },
    WebACLArn: {
      'Fn::GetAtt': [
        'WAFv2',
        'Arn',
      ],
    },
  });
});

test('Test configElement jenkins content to use X-Forwarded-For header on port 443', () => {
  const app = new App({
    context: {
      useSsl: 'true', serverAccessType: 'ipv4', restrictServerAccessTo: '0.0.0.0/0', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResource('AWS::AutoScaling::AutoScalingGroup', {
    /* eslint-disable max-len */
    Metadata: {
      'AWS::CloudFormation::Init': {
        config: {
          files: {
            '/etc/httpd/conf.d/jenkins.conf': {
              // eslint-disable-next-line no-useless-escape,max-len
              content: 'LogFormat \"%{X-Forwarded-For}i %h %l %u %t \\\"%r\\\" %>s %b \\\"%{Referer}i\\\" \\\"%{User-Agent}i\\\"\" combined\n            <VirtualHost *:80>\n                ServerAdmin  webmaster@localhost\n                Redirect permanent / https://replace_url.com/\n            </VirtualHost>\n            <VirtualHost *:443>\n                SSLEngine on\n                SSLCertificateFile /etc/ssl/certs/test-jenkins.opensearch.org.crt\n                SSLCertificateKeyFile /etc/ssl/private/test-jenkins.opensearch.org.key\n                SSLCertificateChainFile /etc/ssl/certs/test-jenkins.opensearch.org.pem\n                ServerAdmin  webmaster@localhost\n                ProxyRequests     Off\n                ProxyPreserveHost On\n                AllowEncodedSlashes NoDecode\n                <Proxy *>\n                    Order deny,allow\n                    Allow from all\n                </Proxy>\n                ProxyPass         /  http://localhost:8080/ nocanon\n                ProxyPassReverse  /  http://localhost:8080/\n                ProxyPassReverse  /  http://replace_url.com/\n                RequestHeader set X-Forwarded-Proto \"https\"\n                RequestHeader set X-Forwarded-Port \"443\"\n            </VirtualHost>\n            <IfModule mod_headers.c>\n              Header unset Server\n            </IfModule>',
              encoding: 'plain',
              mode: '000644',
              owner: 'root',
              group: 'root',
            },
          },
        },
      },
    },
  });
});

test('Test configElement jenkins content to use X-Forwarded-For header on port 80', () => {
  const app = new App({
    context: {
      useSsl: 'false', serverAccessType: 'ipv4', restrictServerAccessTo: '0.0.0.0/0', useProdAgents: 'false',
    },
  });

  // WHEN
  const stack = new CIStack(app, 'MyTestStack', {
    env: { account: 'test-account', region: 'us-east-1' },
  });

  // THEN
  Template.fromStack(stack).hasResource('AWS::AutoScaling::AutoScalingGroup', {
    /* eslint-disable max-len */
    Metadata: {
      'AWS::CloudFormation::Init': {
        config: {
          files: {
            '/etc/httpd/conf.d/jenkins.conf': {
              // eslint-disable-next-line no-useless-escape,max-len
              content: 'LogFormat \"%{X-Forwarded-For}i %h %l %u %t \\\"%r\\\" %>s %b \\\"%{Referer}i\\\" \\\"%{User-Agent}i\\\"\" combined\n            <VirtualHost *:80>\n            ServerAdmin  webmaster@127.0.0.1\n            ProxyRequests     Off\n            ProxyPreserveHost On\n            AllowEncodedSlashes NoDecode\n          \n            <Proxy http://127.0.0.1:8080/>\n                Order deny,allow\n                Allow from all\n            </Proxy>\n          \n            ProxyPass         /  http://127.0.0.1:8080/ nocanon\n            ProxyPassReverse  /  http://127.0.0.1:8080/\n        </VirtualHost>',
              encoding: 'plain',
              mode: '000644',
              owner: 'root',
              group: 'root',
            },
          },
        },
      },
    },
  });
});
