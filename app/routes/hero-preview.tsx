/**
 * Standalone view of the hero section, without the rest of the homepage around
 * it. Useful for judging the animation on its own.
 */
import type {Route} from './+types/hero-preview';
import {buildSeoMeta} from '~/lib/seo';
import {HeroDroneStage} from '~/components/HeroDroneStage';

// A dev view of the hero, never linked: keep it out of search results.
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({title: 'Hero preview', robots: 'noindex,nofollow'});

export default function HeroPreview() {
  return (
    <main className="hp">
      <HeroDroneStage />
      <section className="hp-after">
        <p>Page continues here. The hero releases the scroll once the sequence ends.</p>
      </section>
    </main>
  );
}
