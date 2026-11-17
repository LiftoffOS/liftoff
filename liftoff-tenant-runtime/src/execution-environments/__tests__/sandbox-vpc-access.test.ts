/**
 * A sandbox joins the runtime's VPC the same way the runtime services do.
 *
 * The runtime services moved off the serverless connector to Direct VPC egress
 * on the tenant VPC. A sandbox left on the connector after it is deleted would
 * fail to create; one left off-VPC cannot reach the internal-ingress runtime
 * its sidecar calls back into.
 */
import { sandboxVpcAccess } from '../sandbox-vpc-access';

const NETWORK = 'projects/YOUR_TENANT_PROJECT/global/networks/YOUR_TENANT_PROJECT';
const SUBNET = 'projects/YOUR_TENANT_PROJECT/regions/us-west1/subnetworks/YOUR_TENANT_PROJECT';
const CONNECTOR = 'projects/YOUR_TENANT_PROJECT/locations/us-west1/connectors/liftoffos-connector';

it('uses Direct VPC egress on the named network and subnet, tagged as a sandbox', () => {
  expect(sandboxVpcAccess({ SANDBOX_VPC_NETWORK: NETWORK, SANDBOX_VPC_SUBNET: SUBNET })).toEqual({
    vpcAccess: {
      networkInterfaces: [{ network: NETWORK, subnetwork: SUBNET, tags: ['sandbox'] }],
      egress: 'ALL_TRAFFIC',
    },
  });
});

it('prefers Direct VPC egress when the connector is still set beside it', () => {
  const access = sandboxVpcAccess({ SANDBOX_VPC_NETWORK: NETWORK, SANDBOX_VPC_SUBNET: SUBNET, SANDBOX_VPC_CONNECTOR: CONNECTOR });
  expect(access.vpcAccess).not.toHaveProperty('connector');
});

it('falls back to the connector when no network is named', () => {
  expect(sandboxVpcAccess({ SANDBOX_VPC_CONNECTOR: CONNECTOR })).toEqual({
    vpcAccess: { connector: CONNECTOR, egress: 'ALL_TRAFFIC' },
  });
});

it('needs both network and subnet; one alone is not a network interface', () => {
  expect(sandboxVpcAccess({ SANDBOX_VPC_NETWORK: NETWORK })).toEqual({});
});

it('stays off-VPC when nothing is set', () => {
  expect(sandboxVpcAccess({})).toEqual({});
});
