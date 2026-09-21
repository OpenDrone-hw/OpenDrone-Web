import {useEffect, useState} from 'react';
import {PrefetchPageLinks, useLocation, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {isPurchasableStatus, PRODUCT_CONTENT} from '~/lib/product-content';
import {prefetchImage} from '~/lib/asset-prefetch';
import {shopifyImageUrl, srcsetPick} from '~/lib/shopify-image';

/**
 * Loads what the next click will need while the visitor reads: the code
 * and data of the shop's main pages, each product's first photo at the size
 * its gallery asks for, and every board layer of the product on screen.
 * Network only: nothing is decoded, parsed or laid out, so a slow machine
 * pays no main-thread cost. Starts once the page is idle, runs one step at
 * a time, and is skipped on data saver and 2G/3G connections.
 */

type Conn = {saveData?: boolean; effectiveType?: string};

function canWarm(): boolean {
  const conn = (navigator as Navigator & {connection?: Conn}).connection;
  if (conn?.saveData) return false;
  return !/(^|\b)(slow-2g|2g|3g)$/.test(conn?.effectiveType ?? '');
}

function whenIdle(timeout = 4000): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as Window & {requestIdleCallback?: (cb: () => void, o?: {timeout: number}) => number})
      .requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), {timeout});
    else window.setTimeout(resolve, 600);
  });
}

/** CSS width of the product gallery slide on this screen (ProductGallery sizes). */
function gallerySlot(): number {
  return window.innerWidth >= 960 ? 600 : window.innerWidth * 0.85;
}

function boardSrcs(handle: string): string[] {
  const content = PRODUCT_CONTENT[handle];
  const srcs = [
    content?.teardown?.boardArt?.src,
    ...Object.values(content?.variants ?? {}).map((v) => v.boardArt?.src),
  ].filter((s): s is string => Boolean(s));
  return [...new Set(srcs)];
}

export function BackgroundWarmup() {
  const root = useRouteLoaderData<RootLoader>('root');
  const {pathname} = useLocation();
  const [pages, setPages] = useState<string[]>([]);

  useEffect(() => {
    if (!root || !canWarm()) return;
    let cancelled = false;
    const statuses = root.productStatuses ?? {};
    const products = (root.familyProducts ?? []).filter((p) => isPurchasableStatus(statuses[p.handle]));
    const here = pathname.startsWith('/products/') ? pathname.split('/')[2] : null;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    const run = async () => {
      await whenIdle(6000);
      if (cancelled) return;
      // 1. Code and data for the pages one click away.
      setPages(
        ['/products', '/preorder', ...products.map((p) => `/products/${p.handle}`)].filter(
          (page) => page !== pathname,
        ),
      );
      // 2. The board on screen: every layer of every tier, so the teardown
      //    and a tier switch paint from cache.
      if (here && boardSrcs(here).length) {
        // Loaded here, not imported: the product page already has this
        // chunk, and no other page should carry it.
        const {warmBoardBytes} = await import('~/components/BoardArt');
        for (const src of boardSrcs(here)) {
          await whenIdle();
          if (cancelled) return;
          await warmBoardBytes(src).catch(() => {});
        }
      }
      // 3. Each product's photos at gallery size: the current product's
      //    every tier, the others their first photo.
      const width = srcsetPick(gallerySlot(), dpr, 1080);
      for (const product of products) {
        const images =
          product.handle === here
            ? product.variants.nodes.map((v) => v.image).filter(Boolean)
            : [product.variants.nodes.find((v) => v.availableForSale)?.image ?? product.featuredImage];
        for (const image of images) {
          if (!image?.url) continue;
          await whenIdle();
          if (cancelled) return;
          prefetchImage(shopifyImageUrl(image.url, width));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [root, pathname]);

  return (
    <>
      {pages.map((page) => (
        <PrefetchPageLinks key={page} page={page} />
      ))}
    </>
  );
}
