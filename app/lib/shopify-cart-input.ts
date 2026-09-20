const SKU_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export function requestedLines(form: FormData): Array<{sku: string; quantity: number}> {
  for (const key of ['lines', 'sku', 'qty']) {
    if (form.getAll(key).length > 1) {
      throw new Response('Repeated cart fields are not allowed.', {status: 400});
    }
  }
  const raw: Array<{sku: string; quantity: unknown}> = [];
  const combined = form.get('lines');
  if (form.has('lines')) {
    if (form.has('sku') || form.has('qty')) {
      throw new Response('Use one cart line format.', {status: 400});
    }
    if (typeof combined !== 'string' || !combined.trim()) {
      throw new Response('Invalid cart lines.', {status: 400});
    }
    const items = combined.split(',');
    if (items.length > 20) throw new Response('Too many cart lines.', {status: 400});
    for (const item of items) {
      const parts = item.split(':');
      if (parts.length !== 2) throw new Response('Invalid cart lines.', {status: 400});
      const [sku, quantity] = parts;
      raw.push({sku, quantity});
    }
  } else {
    if (!form.has('sku')) throw new Response('Invalid cart lines.', {status: 400});
    raw.push({sku: String(form.get('sku') ?? ''), quantity: form.get('qty') ?? '1'});
  }
  const aggregated = new Map<string, number>();
  for (const {sku: rawSku, quantity: rawQuantity} of raw) {
    const sku = rawSku.trim();
    const quantity = Number(rawQuantity);
    if (!SKU_RE.test(sku) || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Response('Invalid cart lines.', {status: 400});
    }
    const total = (aggregated.get(sku) ?? 0) + quantity;
    if (!Number.isSafeInteger(total)) {
      throw new Response('Invalid cart lines.', {status: 400});
    }
    aggregated.set(sku, total);
  }
  return [...aggregated].map(([sku, quantity]) => ({sku, quantity}));
}
