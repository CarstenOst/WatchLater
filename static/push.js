(async function () {
  const btn = document.getElementById('enable-push');
  if (!btn) return;

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  let reg;
  try {
    reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (e) {
    console.warn('SW register failed', e);
    return;
  }

  async function currentSubscription() {
    return (await reg.pushManager.getSubscription()) || null;
  }

  async function refreshUi() {
    const sub = await currentSubscription();
    if (sub) {
      btn.textContent = 'Notifications on';
      btn.classList.remove('hidden');
    } else {
      btn.textContent = 'Enable notifications';
      btn.classList.remove('hidden');
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  btn.addEventListener('click', async () => {
    const existing = await currentSubscription();
    if (existing) {
      await fetch('/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      });
      await existing.unsubscribe();
      await refreshUi();
      return;
    }

    let keyRes;
    try {
      keyRes = await fetch('/push/vapid-public-key');
    } catch (e) {
      alert('Could not reach server.');
      return;
    }
    if (!keyRes.ok) {
      alert('Push is not configured on the server. Generate VAPID keys and set them in .env.');
      return;
    }
    const key = (await keyRes.text()).trim();

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    await fetch('/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    await refreshUi();
  });

  await refreshUi();
})();
