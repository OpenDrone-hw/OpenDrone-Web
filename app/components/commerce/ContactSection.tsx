/**
 * The Contact step of the app checkout: the email field and nothing else (founder 2026-10-20: the email is the account,
 * no guest or sign-in choice, no account to create). With a signed-in session the email is filled and the buyer can
 * sign out ("Not you?"). The input is uncontrolled and named `email` (the express checkout fills it by name).
 */
export function ContactSection({accountEmail}: {accountEmail: string | null}) {
  return (
    <section className="co-section">
      <h2 className="co-h">Contact</h2>
      <label className="co-field">
        <span>Email</span>
        <input name="email" type="email" required autoComplete="email" inputMode="email" defaultValue={accountEmail ?? ''} />
      </label>
      {accountEmail ? (
        <p className="co-quiet">
          Signed in as {accountEmail}.{' '}
          <button type="submit" formAction="/account/logout" formNoValidate className="co-remove">Not you? Sign out</button>
          <input type="hidden" name="return_to" value="/shop/cart" />
        </p>
      ) : (
        <p className="co-quiet">We send your receipt and tracking here.</p>
      )}
    </section>
  );
}
