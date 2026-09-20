import type {Route} from './+types/$';

// No meta here: the thrown 404 bubbles to root's ErrorBoundary, and route
// meta below the rendering boundary is discarded - the 404 title comes
// from root.tsx's error-aware meta instead.
export async function loader({request}: Route.LoaderArgs) {
  throw new Response(`${new URL(request.url).pathname} not found`, {
    status: 404,
  });
}

export default function CatchAllPage() {
  return null;
}
