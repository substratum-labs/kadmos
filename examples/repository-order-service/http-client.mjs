import http from 'node:http';
export function post(port, action, id, mode) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: `/${action}?id=${id}&mode=${mode}` }, response => {
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(Error('unavailable')); } });
    });
    request.on('error', reject);
    request.setTimeout(1000, () => request.destroy(Error('timeout')));
    request.end();
  });
}
export async function apply(port, id, mode) {
  try { return await post(port, 'apply', id, mode); }
  catch (error) { throw error; }
}
