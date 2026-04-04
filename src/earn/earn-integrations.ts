/**
 * FLP Integration Partners
 *
 * Informational data about protocols that integrate with Flash LP tokens.
 * Matches the "Explore FLP Integrations" section on the Flash Earn UI.
 */

export interface FlpIntegration {
  name: string;
  description: string;
  supportedToken: string;
  detail: string;
}

export const FLP_INTEGRATIONS: FlpIntegration[] = [
  {
    name: 'Loopscale',
    description: 'Leverage your yield up to 5x with fixed-rate loops',
    supportedToken: 'FLP.1',
    detail: 'loopscale.com',
  },
  {
    name: 'Carrot',
    description: 'Boost FLP.1 yields with up to 3.4x leverage',
    supportedToken: 'FLP.1',
    detail: 'carrot.money',
  },
  {
    name: 'RateX',
    description: 'Trade FLP.1 yield tokens with up to 10x leverage on margin',
    supportedToken: 'FLP.1',
    detail: 'ratex.io',
  },
  {
    name: 'Kamino',
    description: 'Borrow against FLP.1 with up to 75% LTV',
    supportedToken: 'FLP.1',
    detail: 'kamino.finance',
  },
];
