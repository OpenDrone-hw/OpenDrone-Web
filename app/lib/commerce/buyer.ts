import {clientIp} from '../rate-limit.ts';

/** The buyer's own address and browser, sent with the checkout: the app uses them once for the analytics purchase event,
 * which drops events sent from a server address, then empties them. */
export function buyerOf(request: Request): {client_ip?: string; client_user_agent?: string} {
  const ip = clientIp(request);
  const ua = request.headers.get('User-Agent') ?? '';
  return {...(ip !== 'unknown' && ip.length <= 45 ? {client_ip: ip} : {}), ...(ua ? {client_user_agent: ua.slice(0, 300)} : {})};
}
