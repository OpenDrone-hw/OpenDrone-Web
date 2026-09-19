import {data} from 'react-router';
import type {Route} from './+types/api.support.relay';
import {handleRelayRequest, type RelayResult} from '~/lib/support/relay';

// Outbound half of the support bridge: Odoo -> Discord.
//
// erp/addons/incutec_support calls this when an internal user posts a
// public (customer-visible) comment on a ticket that came from a Discord
// thread. Until this route existed the bridge was inbound only and a
// reply typed into the Odoo chatter reached nobody
// (erp/docs/integrations/discord.md, work item D1).
//
// Auth: bearer token matching SUPPORT_RELAY_SECRET, constant-time
// compared. Without that env var (or without DISCORD_BOT_TOKEN /
// DISCORD_SUPPORT_CHANNEL_ID) the endpoint is disabled (503), so it is
// inert until an operator configures both sides.
//
// Body: {thread_id, body, author?, ticket_ref?}. The thread must be a
// post in DISCORD_SUPPORT_CHANNEL_ID; anything else is refused. Every
// rule lives in ~/lib/support/relay.ts, which is where the tests are.

export async function action({request, context}: Route.ActionArgs) {
  const result = await handleRelayRequest(context.env, request);
  return data<RelayResult>(result.body, {
    status: result.status,
    headers: {'Cache-Control': 'no-store', ...(result.headers ?? {})},
  });
}

export function loader() {
  return new Response(null, {status: 404});
}
