import {shopifyImageUrl, shopifySrcSet} from '~/lib/shopify-image';
import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/newsletter.$handle';
import {buildSeoMeta} from '~/lib/seo';
import {archivePosts, postByHandle, postHtml} from '~/lib/posts';
import {VersionChip, pickVersionTag} from '~/components/release-notes/VersionChip';
import {PrevNextNav} from '~/components/release-notes/PrevNextNav';
import {FILTER_TAGS, type FilterTag} from '~/components/release-notes/TagFilter';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

export const meta: Route.MetaFunction = ({data}) =>
  buildSeoMeta({
    title:
      data?.article?.title ||
      copyText('newsletter.post_meta_title_fallback') ||
      'Post',
    description: data?.article?.excerpt || undefined,
    image: data?.article?.image?.url,
    type: 'article',
  });

function pickFilterTag(tags: readonly string[]): FilterTag | null {
  for (const t of tags) {
    const lower = t.toLowerCase();
    if ((FILTER_TAGS as readonly string[]).includes(lower)) {
      return lower as FilterTag;
    }
  }
  return null;
}

export function loader({params}: Route.LoaderArgs) {
  const articleHandle = params.handle;
  if (!articleHandle) throw new Response('Not found', {status: 404});

  const post = postByHandle(articleHandle);
  if (!post) throw new Response(null, {status: 404});

  const article = {
    handle: post.handle,
    title: post.title,
    publishedAt: post.publishedAt,
    excerpt: post.excerpt,
    tags: post.tags,
    image: post.image,
    contentHtml: postHtml(post),
  };

  const siblings = archivePosts().map((p) => ({
    handle: p.handle,
    title: p.title,
    publishedAt: p.publishedAt,
  }));
  const idx = siblings.findIndex((sib) => sib.handle === article.handle);
  // siblings ordered DESC by publishedAt - newer first, so "next" (more
  // recent) sits at idx-1, "previous" (older) at idx+1.
  const next = idx > 0 ? siblings[idx - 1] : null;
  const previous =
    idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;

  return {article, previous, next};
}

export default function NewsletterPost() {
  const {article, previous, next} = useLoaderData<typeof loader>();
  const {title, image, contentHtml, publishedAt, tags, excerpt} = article;
  const date = (() => {
    try {
      return new Date(publishedAt).toISOString().slice(0, 10);
    } catch {
      return '';
    }
  })();
  const version = pickVersionTag(tags ?? []);
  const tag = pickFilterTag(tags ?? []);

  return (
    <article className="page-shell">
      <div className="rn-post-page">
        <div className="rn-post-crumb">
          <Link prefetch="viewport" to="/newsletter">
            <Txt id="newsletter.post_crumb" />
          </Link>
          <span className="rn-sep">/</span>
          <span>{article.handle}</span>
        </div>

        <div className="rn-post-meta">
          <time dateTime={publishedAt}>{date}</time>
          {version ? (
            <>
              <span className="rn-dot">·</span>
              <VersionChip version={version} />
            </>
          ) : null}
          {tag ? (
            <>
              <span className="rn-dot">·</span>
              <span className={`rn-tag is-${tag}`}>{tag}</span>
            </>
          ) : null}
        </div>

        <h1 className="rn-post-title">{title}</h1>
        {excerpt ? <p className="rn-post-deck">{excerpt}</p> : null}

        {image ? (
          <div className="rn-post-hero">
            <img
              loading="eager"
              sizes="(min-width: 768px) 920px, 100vw"
              srcSet={shopifySrcSet(image.url, 1840)}
              src={shopifyImageUrl(image.url, 920)}
              decoding="async"
              alt={image.altText || title}
            />
          </div>
        ) : null}

        <div
          dangerouslySetInnerHTML={{__html: contentHtml}}
          className="rn-post-body"
        />

        <PrevNextNav previous={previous} next={next} />
      </div>
    </article>
  );
}
