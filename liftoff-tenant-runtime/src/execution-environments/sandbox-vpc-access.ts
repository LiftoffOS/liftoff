// How a per-session sandbox service joins the runtime's VPC.

/** The network tag every sandbox carries on Direct VPC egress, so a firewall
 *  rule can single out sandboxes (a connector carries no tags): a sandbox runs
 *  code nobody reviewed. Its callbacks to the runtime go to run.app addresses,
 *  which are not private ranges. */
const SANDBOX_NETWORK_TAG = 'sandbox';

/**
 * How a sandbox joins the runtime's VPC, from the environment.
 *
 * Direct VPC egress (`SANDBOX_VPC_NETWORK` + `SANDBOX_VPC_SUBNET`, full
 * resource names, which may name a Shared VPC host project) wins over the
 * serverless connector (`SANDBOX_VPC_CONNECTOR`), so the services can move off
 * the connector before it is deleted. Neither set: off-VPC, as before.
 */
export function sandboxVpcAccess(env: NodeJS.ProcessEnv): { vpcAccess?: Record<string, unknown> } {
  if (env.SANDBOX_VPC_NETWORK && env.SANDBOX_VPC_SUBNET) {
    return {
      vpcAccess: {
        networkInterfaces: [{
          network: env.SANDBOX_VPC_NETWORK,
          subnetwork: env.SANDBOX_VPC_SUBNET,
          tags: [SANDBOX_NETWORK_TAG],
        }],
        egress: 'ALL_TRAFFIC',
      },
    };
  }
  if (env.SANDBOX_VPC_CONNECTOR) {
    return { vpcAccess: { connector: env.SANDBOX_VPC_CONNECTOR, egress: 'ALL_TRAFFIC' } };
  }
  return {};
}
