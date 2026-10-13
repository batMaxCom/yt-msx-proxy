#!/usr/bin/env python3
"""Мини CDP-клиент (Chrome DevTools Protocol) на чистом Python.

Работает с Chromium, запущенным с --remote-debugging-port (контейнер pw-cdp).
Умеет: открыть URL, подождать загрузку, снять скриншот, выполнить JS,
нажать клавиши (навигация «с пульта»), показать console.log и ошибки сети.

Примеры:
  python3 cdp_client.py http://127.0.0.1:8080/ --out /tmp/shot.png
  python3 cdp_client.py "http://127.0.0.1:8080/results?search_query=test" --wait 6000 --out /tmp/search.png
  python3 cdp_client.py http://127.0.0.1:8080/ --eval "document.title"
  python3 cdp_client.py http://127.0.0.1:8080/ --keys "ArrowRight ArrowRight Enter"
"""
import argparse
import asyncio
import base64
import json
import sys
import urllib.request

import websockets

DEVTOOLS = 'http://127.0.0.1:9222'


def browser_ws_url() -> str:
    with urllib.request.urlopen(f'{DEVTOOLS}/json/version', timeout=5) as r:
        ver = json.load(r)
    return ver['webSocketDebuggerUrl']


def page_ws_url() -> str:
    """Присоединяемся к первой вкладке-странице (обычно пустая newtab)."""
    with urllib.request.urlopen(f'{DEVTOOLS}/json/list', timeout=5) as r:
        targets = json.load(r)
    pages = [t for t in targets if t.get('type') == 'page']
    if not pages:
        raise RuntimeError('нет вкладок-страниц в браузере')
    return pages[0]['webSocketDebuggerUrl']


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.mid = 0
        self.events = asyncio.Queue()
        self.console = []

    async def send(self, method, params=None):
        self.mid += 1
        await self.ws.send(json.dumps({'id': self.mid, 'method': method, 'params': params or {}}))
        return self.mid

    async def wait_response(self, rid, timeout=30):
        stash = []
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout)
            msg = json.loads(raw)
            if msg.get('id') == rid:
                for m in stash:
                    self.events.put_nowait(m)
                return msg
            stash.append(msg)

    async def cmd(self, method, params=None, timeout=30):
        rid = await self.send(method, params)
        return await self.wait_response(rid, timeout)

    async def wait_event(self, method, timeout=15):
        while True:
            msg = await asyncio.wait_for(self.events.get(), timeout)
            if msg.get('method') == method:
                return msg


async def run(args):
    url = page_ws_url()
    print(f'[*] CDP page: {url[:80]}...')
    async with websockets.connect(url, max_size=100 * 1024 * 1024) as ws:
        cdp = CDP(ws)
        reader = asyncio.create_task(pump(ws, cdp))

        await cdp.cmd('Runtime.enable')
        await cdp.cmd('Log.enable')
        await cdp.cmd('Page.enable')
        await cdp.cmd('Network.enable')

        rid = await cdp.send('Page.navigate', {'url': args.url})
        resp = await cdp.wait_response(rid)
        if 'errorText' in (resp.get('result') or {}):
            print(f'[!] navigate error: {resp["result"]["errorText"]}')
        try:
            await cdp.wait_event('Page.loadEventFired', timeout=20)
        except asyncio.TimeoutError:
            print('[*] loadEventFired not seen in 20s, continuing')

        await asyncio.sleep(args.wait / 1000)

        if args.keys:
            for key in args.keys.split():
                await press(ws, cdp, key)
                await asyncio.sleep(0.15)
            await asyncio.sleep(args.wait / 1000)

        if args.eval:
            r = await cdp.cmd('Runtime.evaluate', {
                'expression': args.eval, 'returnByValue': True,
                'awaitPromise': True,
            })
            print('=== eval ===')
            print(json.dumps(r.get('result', {}).get('result', {}), ensure_ascii=False, indent=1)[:4000])

        if args.out:
            r = await cdp.cmd('Page.captureScreenshot', {'format': 'png'})
            if 'result' in r and 'data' in r['result']:
                with open(args.out, 'wb') as f:
                    f.write(base64.b64decode(r['result']['data']))
                print(f'[*] screenshot -> {args.out}')
            else:
                print(f'[!] screenshot failed: {json.dumps(r)[:300]}')

        print('=== console ===')
        for line in cdp.console[-60:]:
            print(line)
        reader.cancel()


async def pump(ws, cdp):
    try:
        async for raw in ws:
            msg = json.loads(raw)
            if 'method' in msg:
                m = msg['method']
                if m == 'Runtime.consoleAPICalled':
                    texts = [json.dumps(a.get('value', a.get('description', '')), ensure_ascii=False)
                             for a in msg['params'].get('args', [])]
                    cdp.console.append(f"[{msg['params'].get('type')}] " + ' '.join(texts)[:500])
                elif m == 'Log.entryAdded':
                    e = msg['params']['entry']
                    cdp.console.append(f"[log:{e.get('level')}] {e.get('text', '')[:300]}")
                elif m == 'Network.responseReceived':
                    st = msg['params']['response'].get('status')
                    if st and st >= 400:
                        u = msg['params']['response'].get('url', '')
                        cdp.console.append(f"[http:{st}] {u[:200]}")
                cdp.events.put_nowait(msg)
    except asyncio.CancelledError:
        pass


async def press(ws, cdp, key):
    special = {
        'ArrowDown': 40, 'ArrowUp': 38, 'ArrowLeft': 37, 'ArrowRight': 39,
        'Enter': 13, 'Escape': 27, 'Backspace': 8, 'Tab': 9,
    }
    if key in special:
        code = special[key]
        for t in ('rawKeyDown', 'keyUp'):
            await ws.send(json.dumps({'id': cdp.mid + 100000, 'method': 'Input.dispatchKeyEvent',
                                      'params': {'type': t, 'key': key,
                                                 'windowsVirtualKeyCode': code, 'code': key}}))
            cdp.mid += 1
    else:
        for t in ('keyDown', 'char', 'keyUp'):
            await ws.send(json.dumps({'id': cdp.mid + 100000, 'method': 'Input.dispatchKeyEvent',
                                      'params': {'type': t, 'text': key}}))
            cdp.mid += 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url')
    ap.add_argument('--out', default=None, help='путь для PNG-скриншота')
    ap.add_argument('--eval', default=None, help='JS для выполнения после загрузки')
    ap.add_argument('--keys', default='', help='клавиши через пробел: "ArrowDown Enter"')
    ap.add_argument('--wait', type=int, default=4000, help='мс ожидания после загрузки')
    args = ap.parse_args()
    try:
        asyncio.run(run(args))
    except Exception as e:
        print(f'[!] {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
