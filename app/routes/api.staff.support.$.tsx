import type {Route} from './+types/api.staff.support.$';
import {handleStaff} from '~/lib/support/staff-api';

/**
 * /api/staff/support/*: the staff API of the support CRM for the internal
 * app. Answers 404 while SUPPORT_CRM_API is off. Contract: README "Support
 * tickets", "Staff API". Bearer token, optional Cloudflare Access.
 */
export async function loader({request, context}: Route.LoaderArgs) {
  return handleStaff(request, context.env, {origin: new URL(request.url).origin, defer: context.waitUntil});
}

export async function action({request, context}: Route.ActionArgs) {
  return handleStaff(request, context.env, {origin: new URL(request.url).origin, defer: context.waitUntil});
}
