export async function sendExpoPush(token, title, body, data = {}) {
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ to: token, title, body, data, sound: 'default', priority: 'high' }),
  });
  const json = await res.json();
  if (json.data?.status === 'error') throw new Error(json.data.message);
  return json;
}
