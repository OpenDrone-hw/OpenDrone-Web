import {
  inspectShippingInvoice,
  sendShippingInvoice,
} from '../app/lib/shopify-shipping-invoice.ts';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.warn(
    'Usage: npm run shopify:shipping-invoice -- --order gid://shopify/Order/123 --amount 12.34 --service "Standard tracked" --reference PACK-123 [--send]',
  );
  process.exit(0);
}

const input = {
  orderId: argument('--order') ?? '',
  amount: argument('--amount') ?? '',
  service: argument('--service') ?? '',
  reference: argument('--reference') ?? '',
};
const send = process.argv.includes('--send');

try {
  const result = send
    ? await sendShippingInvoice(process.env, input)
    : await inspectShippingInvoice(process.env, input);
  console.warn(
    JSON.stringify({mode: send ? 'sent' : 'preview', ...result}, null, 2),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Shipping invoice failed',
  );
  process.exitCode = 1;
}
