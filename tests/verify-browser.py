"""真實瀏覽器端對端驗證：檢驗 390px 行動版無橫向捲軸、200% 字級縮放、CSP 零外部請求、XSS 防護、IME 防護、Web Worker 預覽與 .cube 下載。"""

import functools
import http.server
import shutil
import socketserver
import tempfile
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright


class QuietHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    handler = functools.partial(QuietHTTPRequestHandler, directory=str(root))
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base_url = f'http://127.0.0.1:{port}/index.html'

    tmp_dir = Path(tempfile.mkdtemp(prefix='fujilut-e2e-'))
    try:
        cube_path = tmp_dir / 'FLog2_to_CLASSIC-Neg._65grid_V.1.00.cube'
        lines = [
            '# Fujifilm 65Grid E2E Test',
            'TITLE "<img src=x onerror=window.__xss=1>"',
            'LUT_3D_SIZE 65',
            'DOMAIN_MIN 0.0 0.0 0.0',
            'DOMAIN_MAX 1.0 1.0 1.0',
        ]
        inv = 1.0 / 64.0
        for ib in range(65):
            b = ib * inv
            for ig in range(65):
                g = ig * inv
                for ir in range(65):
                    r = ir * inv
                    lines.append(f'{r:.6f} {g:.6f} {b:.6f}')
        cube_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')

        external_requests: list[str] = []
        console_errors: list[str] = []
        page_errors: list[str] = []

        with sync_playwright() as p:
            browser = None
            for ch in ('msedge', 'chrome', None):
                try:
                    browser = p.chromium.launch(channel=ch, headless=True) if ch else p.chromium.launch(headless=True)
                    print(f'[Browser] Launched Chromium channel={ch}')
                    break
                except Exception:
                    continue
            assert browser is not None, '找不到可用的 Chromium / Edge / Chrome 瀏覽器'

            context = browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True)
            page = context.new_page()

            page.on(
                'request',
                lambda req: external_requests.append(req.url)
                if not req.url.startswith((f'http://127.0.0.1:{port}/', 'blob:', 'data:'))
                else None,
            )
            page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
            page.on('pageerror', lambda err: page_errors.append(str(err)))

            page.goto(base_url, wait_until='networkidle')

            # 1. 檢驗 390px 行動裝置視窗下無橫向捲軸，且所有可見互動控制項 >= 24x24 CSS px
            dims = page.evaluate(
                """() => ({
                    scrollWidth: document.documentElement.scrollWidth,
                    clientWidth: document.documentElement.clientWidth,
                })"""
            )
            assert dims['scrollWidth'] <= dims['clientWidth'], f'390px 發生橫向捲軸溢位: {dims}'

            small_controls = page.evaluate(
                """() => {
                    const targets = document.querySelectorAll('button, summary, input[type="range"], .drop-zone, .radio-card');
                    const bad = [];
                    for (const el of targets) {
                        if (el.offsetParent === null) continue;
                        const rect = el.getBoundingClientRect();
                        if (rect.width < 24 || rect.height < 24) {
                            bad.push({ tag: el.tagName, id: el.id, className: el.className, w: rect.width, h: rect.height });
                        }
                    }
                    return bad;
                }"""
            )
            assert len(small_controls) == 0, f'發現小於 24x24px 的互動控制項: {small_controls}'
            print('[PASS] 390px 行動視窗無橫向捲軸，且所有可見控制項尺寸均 >= 24x24px')

            # 2. 驗證未上傳直接點擊送出時，按鈕維持焦點且正確設定 aria-invalid="true" 與 aria-describedby
            page.click('#convert-download-btn')
            assert page.get_attribute('#cube-file-input', 'aria-invalid') == 'true'
            assert 'cube-file-error' in (page.get_attribute('#cube-file-input', 'aria-describedby') or '')
            print('[PASS] 未選檔送出時無障礙驗證狀態（aria-invalid / aria-describedby）同步正確')

            # 3. 上傳含惡意 XSS TITLE 之 65Grid .cube 母片
            page.set_input_files('#cube-file-input', str(cube_path))
            page.wait_for_function("() => document.getElementById('meta-grid').textContent.includes('65Grid')")

            assert not page.evaluate('() => Boolean(window.__xss)'), '惡意 TITLE 觸發了 XSS！'
            assert '<img src=x onerror=window.__xss=1>' in (page.text_content('#meta-title') or '')
            assert page.text_content('#snapseed-thumb-label') == '人文街拍_…'
            assert page.get_attribute('#cube-file-input', 'aria-invalid') == 'false'
            assert 'cube-file-error' not in (page.get_attribute('#cube-file-input', 'aria-describedby') or '')
            print('[PASS] 65Grid Web Worker 背景解析、DOM XSS 攔截與 Snapseed 9 半形截斷預覽通過')

            # 4. 展開 <details> 本地測試照片即時預覽，檢驗 Worker 渲染與原生方向鍵微調
            page.click('.preview-summary')
            page.wait_for_function(
                "() => document.getElementById('preview-meta-note').textContent.includes('即時預覽已更新')"
            )
            page.focus('#compare-slider')
            page.keyboard.press('ArrowRight')
            assert page.text_content('#compare-slider-output') == '51%'
            assert '原圖 51%，套用濾鏡 49%' == page.get_attribute('#compare-slider', 'aria-valuetext')
            print('[PASS] 原生 <details> 展開、Worker Canvas 渲染與鍵盤方向鍵微調對比滑桿通過')

            # 5. 檢驗自訂名稱輸入框 IME 組字 Enter 防護（keyCode === 229 與 isComposing）
            page.click('#naming-custom')
            page.fill('#custom-name-input', '京都秋日_Classic-Neg')
            ime_submitted = page.evaluate(
                """() => {
                    let triggered = false;
                    const form = document.getElementById('converter-form');
                    const onSub = () => { triggered = true; };
                    form.addEventListener('submit', onSub, { once: true });
                    const input = document.getElementById('custom-name-input');
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
                    form.removeEventListener('submit', onSub);
                    return triggered;
                }"""
            )
            assert not ime_submitted, 'IME 組字中按 Enter 不得觸發送出！'
            page.click('#naming-short')
            print('[PASS] 中文／注音輸入法 IME 組字 Enter 防誤觸通過')

            # 6. 檢驗 200% 系統字級縮放（32px 根字級 @ 390px 視窗寬度）下仍無橫向捲軸溢位
            dims_200 = page.evaluate(
                """() => {
                    document.documentElement.style.fontSize = '32px';
                    const sw = document.documentElement.scrollWidth;
                    const cw = document.documentElement.clientWidth;
                    document.documentElement.style.fontSize = '';
                    return { scrollWidth: sw, clientWidth: cw };
                }"""
            )
            assert dims_200['scrollWidth'] <= dims_200['clientWidth'], f'200% 字級縮放發生橫向溢位: {dims_200}'
            print(f'[PASS] 390px 視窗下 200% 字級縮放排版無橫向捲軸溢位: {dims_200}')

            # 7. 檢驗一鍵轉換與下載 .cube 檔案內容及副檔名保留
            with page.expect_download() as dl_info:
                page.click('#convert-download-btn')
            download = dl_info.value
            assert download.suggested_filename == '人文街拍_Classic-Neg.cube'
            dl_target = tmp_dir / download.suggested_filename
            download.save_as(str(dl_target))
            dl_lines = dl_target.read_text(encoding='utf-8').splitlines()
            assert dl_lines[0] == 'TITLE "人文街拍_Classic-Neg"'
            assert dl_lines[1] == 'LUT_3D_SIZE 33'
            assert len(dl_lines) == 33**3 + 4
            print(f'[PASS] 一鍵下載驗證成功：{download.suggested_filename}（共 {len(dl_lines)} 行）')

            assert len(external_requests) == 0, f'偵測到外部網路請求: {external_requests}'
            assert len(console_errors) == 0, f'瀏覽器 Console 錯誤: {console_errors}'
            assert len(page_errors) == 0, f'頁面執行期例外: {page_errors}'
            print('[PASS] 零外部網路請求、零 Console 錯誤、零 CSP 違規！')

            browser.close()
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
