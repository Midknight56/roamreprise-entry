import { api, isMock } from './api.js';
import { money } from './shared.js';
let sdkPromise;
// Reuse the sandbox SDK, but allow another attempt after a script load failure.
function loadSdk(clientId) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.sandbox.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=authorize&components=buttons&disable-funding=paylater,card`;
    script.onload = () =>
      window.paypal
        ? resolve(window.paypal)
        : reject(new Error('PayPal did not load. Use the card button.'));
    script.onerror = () =>
      reject(new Error('PayPal is unavailable. Use the card button.'));
    document.head.append(script);
  }).catch((error) => {
    sdkPromise = undefined;
    throw error;
  });
  return sdkPromise;
}
// Only approved quotes expose a card or wallet authorization control.
export async function renderPay(
  container,
  trip,
  config,
  { run, onError, isBusy, setBusy },
) {
  container.replaceChildren();
  if (!trip.next.includes('pay')) return;
  container.innerHTML = `
    <button class="primary" id="pay-card">Hold ${money(trip.quote?.totalCents || trip.itinerary.totalCents)} with card (no sign in)</button>
    <p class="payment-boundary">${isMock ? 'Mock payment. No PayPal request is sent.' : 'Nothing is charged yet.'}</p>
    <div class="paypal-box"><strong>Pay with PayPal</strong><div class="paypal-slot"><p class="fine">Loading PayPal button...</p></div><details class="judge-login"><summary>For judges: PayPal buyer login</summary><span id="judge-email">sb-bzdbn21339224@personal.example.com</span><button type="button" class="text-button" id="copy-judge-email">Copy</button><small>PayPal sandbox buyer. Password in the README.</small></details></div>
  `;
  const actions = document.querySelector('#actions');
  if (actions) {
    const details = document.createElement('details');
    details.className = 'failure-paths';
    details.innerHTML = `<summary>For judges: failure paths</summary><button class="text-button" id="decline-card">Try a declined card</button>${isMock ? '<button class="text-button" id="checking-test">Try a lost payment response</button>' : ''}`;
    actions.append(details);
  }
  container.querySelector('#copy-judge-email').onclick = async function copyJudgeEmail() {
    await navigator.clipboard.writeText(container.querySelector('#judge-email').textContent);
    this.textContent = 'Copied';
  };
  container.querySelector('#pay-card').onclick = function holdCard() {
    return run(() => api.card(trip.id));
  };
  document.querySelector('#actions #decline-card')?.addEventListener('click', function declineCard() {
    return run(() => api.card(trip.id, true));
  });
  const fault = document.querySelector('#actions #checking-test');
  if (fault)
    fault.onclick = function loseResponse() {
      return run(async function authorizeWithLostResponse() {
        await api.fault();
        return api.card(trip.id);
      });
    };
  const slot = container.querySelector('.paypal-slot');
  if (isMock) {
    slot.innerHTML =
      '<p class="fine">PayPal wallet is disabled in mock mode.</p>';
    return;
  }
  if (!config.paypalClientId) {
    slot.innerHTML =
      '<p class="fine">PayPal button unavailable, use the card button</p>';
    return;
  }
  try {
    const paypal = await loadSdk(config.paypalClientId);
    if (!slot.isConnected) return;
    slot.replaceChildren();
    await paypal
      .Buttons({
        style: { layout: 'horizontal', height: 42, tagline: false },
        onClick(_data, actions) {
          if (isBusy()) return actions.reject();
          setBusy(true);
          return actions.resolve();
        },
        async createOrder() {
          try {
            const { orderId } = await api.order(trip.id);
            return orderId;
          } catch (e) {
            setBusy(false);
            throw e;
          }
        },
        async onApprove(data) {
          setBusy(false);
          await run(() => api.authorize(trip.id, data.orderID));
        },
        onCancel() {
          setBusy(false);
          onError(
            new Error(
              'PayPal approval cancelled. No new authorization was approved.',
            ),
          );
        },
        onError(error) {
          setBusy(false);
          onError(
            new Error(
              `PayPal wallet: ${error.message || 'approval unavailable'}`,
            ),
          );
        },
      })
      .render(slot);
  } catch (error) {
    if (slot.isConnected) slot.textContent = 'PayPal button unavailable, use the card button';
  }
}
