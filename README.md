# Device Snapshot Center

Satu web dashboard saja: PHP di folder `server/`.

Dashboard production / server agent saat ini:

```text
https://lppsp.ui.ac.id/any/server
```

Node.js di proyek ini hanya dipakai untuk agent device yang melakukan outbound polling ke dashboard PHP.

## Struktur

```text
server/   PHP dashboard, API, schema, dan asset web
agent/    Node.js device agent
storage/  Penyimpanan artifact di luar folder public server
```

## Setup Cepat Lokal

1. Buat file config lokal:

```powershell
Copy-Item .env.example .env
```

2. Edit `.env` sesuai mesin kamu:

- `APP_DB_DSN`
- `APP_DB_USER`
- `APP_DB_PASSWORD`
- `APP_ADMIN_USER`
- `APP_ADMIN_PASSWORD` atau `APP_ADMIN_PASSWORD_HASH`
- `APP_ENROLLMENT_CODE`
- `APP_BASE_PATH`
- `APP_RELEASE` (`auto` menghitung identitas build dari file kritis)
- `APP_UPLOAD_DIR`
- `APP_MAX_UPLOAD_BYTES`

Untuk testing lokal di folder proyek seperti kondisi sekarang, `APP_BASE_PATH=auto` sudah cukup.

Setelah deploy, buka `https://domain/path/server/version.php`. Endpoint tersebut menampilkan release dan hash file kritis. Pastikan `assets/app.js`, `api/live.php`, dan `api/poll.php` berasal dari deployment yang sama. CSS dan JavaScript memakai query version otomatis agar browser tidak mempertahankan asset lama.

Jika URL `version.php` malah menampilkan HTML website utama, file belum terdeploy ke document path yang benar atau rewrite hosting menangkap file yang tidak ditemukan.

Verifikasi deployment lengkap dari root proyek:

```powershell
node scripts/verify-deployment.mjs https://lppsp.ui.ac.id/any/server
```

Lihat [DEPLOYMENT.md](DEPLOYMENT.md) untuk release checklist, OPcache, dan rollback.

Checklist tindakan production yang masih wajib dilakukan tersimpan di [USER_ACTION_REQUIRED.md](USER_ACTION_REQUIRED.md).

Uji migrasi schema, expiry input live, dan pemulihan agent restart:

```powershell
C:\xampp\php\php.exe scripts\test-reliability.php
```

3. Buat database dan import schema:

```sql
SOURCE server/schema.sql;
```

Atau import `server/schema.sql` lewat phpMyAdmin.

4. Untuk development lokal saja, jalankan PHP dari root proyek dengan host/port pilihan kamu. Jangan pakai URL lokal sebagai `serverUri` agent production.

Kalau nanti folder `server/` dijadikan document root hosting, URL dashboard bisa menjadi root domain/subdomain. Kalau dipasang di subfolder, `APP_BASE_PATH=auto` akan mendeteksi path seperti `/tools/device-center`.

## Setup Agent Device

1. Buat config agent:

```powershell
Copy-Item agent\agent.config.example.json agent\agent.config.json
```

2. Edit `agent/agent.config.json`:

- `serverUri`: `https://lppsp.ui.ac.id/any/server` (`serverUrl` masih diterima sebagai alias lama)
- `initialTransportMode`: metode awal agent, default `poll`; dashboard dapat menggantinya tanpa restart.
- `heartbeatLogMs`: interval heartbeat log saat agent idle, default `30000`.
- `configReloadMs`: interval agent membaca ulang `agent.config.json`; default `2000`.
- `enrollmentCode`: samakan dengan `APP_ENROLLMENT_CODE` di `.env`
- `wheelScrollMultiplier`: tuning scroll khusus device agent, default `16`; turunkan bila wheel terlalu agresif.
- `deviceName`: nama yang muncul di dashboard
- `logDirectory`: folder log yang boleh dibaca agent
- `fileTransferRoot`: folder aman untuk file transfer dua arah
- `allowKeyboardInput`: aktifkan input keyboard remote jika memang dibutuhkan
- `allowClipboardPaste`: aktifkan copy/paste clipboard dari dashboard ke agent
- `maxClipboardTextBytes`: batas ukuran text clipboard, default `8192`
- `allowFileTransfer`: aktifkan file manager remote
- `allowSessionRecording`: aktifkan recording artifact berbasis screenshot
- `allowPowerControl`: aktifkan display on/off, restart device, sleep/hibernate, dan restart agent dari dashboard
- `allowWebRtcTransport`: aktifkan WebRTC data channel untuk input/control direct, default `true`
- `webRtcSignalPollMs`: interval agent mengecek offer WebRTC dari server PHP
- `webRtcIceServers`: daftar STUN/TURN untuk WebRTC; TURN disarankan jika agent/browser berada di NAT ketat
- `preventSleepWhileRunning`: cegah Windows sleep/display sleep selama agent berjalan; default `false`

3. Jalankan agent:

```powershell
cd agent
npm.cmd install
node agent.js
```

Agent menyimpan token di `agent/agent.state.json`, lalu memulai HTTP polling dan mengikuti pilihan metode dari dashboard. Jika token ditolak setelah deployment atau pemulihan database, agent otomatis melakukan enrollment ulang. Jika request panjang diblokir proxy, circuit breaker otomatis turun ke short-poll tanpa restart agent.

Agent `1.10+` membaca ulang config lokal secara berkala. Perubahan seperti interval, permission, WebRTC, wheel multiplier, folder transfer/log, dan `preventSleepWhileRunning` bisa aktif saat proses masih berjalan. Jika `serverUri` atau `enrollmentCode` berubah, agent akan mencoba re-enroll ke server baru; untuk perpindahan production yang rapi, gunakan tombol `Save + Restart` di Agent Manager.

## Native Agent Manager

Agent punya manager native Windows untuk mengubah config dan mengontrol proses tanpa membuka file JSON manual. Jalur ini paling nyaman untuk device baru karena bisa menyiapkan Node.js dan dependency agent otomatis:

```powershell
cd agent
.\Device Snapshot Agent Manager.cmd
```

Atau dari PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\native-manager.ps1
```

Fitur Native Agent Manager:

- berjalan sebagai window Windows native, bukan halaman browser;
- mencari Node.js dari `DEVICE_SNAPSHOT_NODE`, runtime portable lokal, atau `PATH`;
- tombol `Bootstrap Node + Dependencies` mengunduh Node.js LTS portable dari `nodejs.org`, lalu menjalankan `npm install --omit=dev`;
- edit `serverUri`, enrollment code, nama device, interval polling, WebRTC toggle, scroll multiplier, folder log/transfer, dan capability toggles;
- `Save` untuk hot-reload config yang didukung;
- `Save + Restart` untuk restart agent setelah perubahan besar;
- start, stop, dan restart agent lokal;
- install/start/stop/uninstall Scheduled Task `DeviceSnapshotAgent`;
- memilih `NodePath` dan opsi `WakeToRun` jika Windows/hardware mengizinkan wake timer;
- membaca log `agent-native`, `agent-service`, `supervisor`, dan `npm-install`.

Native manager dapat berjalan sebelum Node.js tersedia karena dibuat dengan PowerShell/WinForms bawaan Windows. Runtime Node portable yang diunduh disimpan di `agent/runtime/node/` dan tidak ikut Git.

## Web Agent Manager

Selain manager native, masih tersedia GUI lokal berbasis Node.js:

```powershell
cd agent
npm.cmd run manager
```

Secara default GUI web terbuka di:

```text
http://127.0.0.1:8765/
```

GUI web hanya bind ke `127.0.0.1`, sehingga panel manager tidak dibuka ke jaringan publik.

Untuk menjalankan agent Windows tanpa logon, buka PowerShell sebagai Administrator di folder `agent/`, lalu jalankan:

```powershell
.\install-startup-task.ps1 -NodePath "C:\nvm4w\nodejs\node.exe"
```

Installer membuat Scheduled Task `DeviceSnapshotAgent` sebagai `SYSTEM` (`LogonType=ServiceAccount`, `RunLevel=Highest`) dan menjalankan `agent-supervisor.ps1`, sehingga agent otomatis start saat boot sebelum user login Windows dan restart jika proses agent keluar. Hapus dengan:

```powershell
.\uninstall-startup-task.ps1
```

Agent tidak bisa memproses command saat device benar-benar sleep/hibernate karena CPU dan network berhenti. Tidak ada Node.js, Scheduled Task, service, atau GUI biasa yang bisa terus mengeksekusi kode ketika mesin benar-benar asleep/hibernated. Yang bisa dilakukan adalah:

- membuat agent start sebelum Windows logon lewat Scheduled Task `SYSTEM`;
- membiarkan proses resume setelah wake;
- mengaktifkan `preventSleepWhileRunning=true` agar Windows tidak masuk sleep saat agent aktif;
- memasang task dengan `-WakeToRun` atau lewat GUI jika perangkat, BIOS, Windows power policy, dan trigger task mengizinkan wake timer.

## Fitur Yang Ada

- Login admin dengan password dari `.env`.
- Device enroll otomatis saat agent berjalan.
- Dashboard PHP menampilkan address book, device profile, antrean tugas, riwayat hasil, artifact, dan audit event.
- Dashboard memakai visual system neumorphism: panel soft-raised, input inset, custom switch/dropdown/dropzone, dan state kontrol yang konsisten di PHP.
- API PHP untuk enroll, polling, upload artifact, dan mark complete.
- Agent hanya menjalankan action allowlist.
- Permission profile per device: `view`, `control`, `files`, atau `full`.
- Snapshot layar melalui action `capture_screen`, dengan preview gambar langsung di dashboard.
- Live screen di dashboard PHP melalui frame berkala dari agent.
- Fullscreen live screen melalui browser Fullscreen API.
- Mode live speed `Eco`, `Flow`, dan `Burst` untuk mengatur ritme request frame dari dashboard.
- Profil speed benar-benar berbeda: `Eco` menghemat request, `Flow` seimbang, dan `Burst` mengutamakan frame serta input paling cepat.
- Capture layar dan session recording berjalan di background agent agar polling mouse/keyboard tidak berhenti selama frame diambil atau di-upload.
- Endpoint live dan artifact melepaskan PHP session lock setelah autentikasi, sehingga frame, status, mouse, dan keyboard dapat diproses paralel pada PHP-FPM/Apache.
- Polling agent adaptif: idle melambat, sedangkan sesi Eco/Flow/Burst mempercepat command pickup sesuai profil aktif.
- Frame live identik dideteksi melalui SHA-256 dan tidak di-upload ulang; freshness tetap mengikuti capture terbaru.
- Capture layar memakai single-flight pipeline di agent; frame live yang menumpuk dikompaksi agar screenshot/upload tidak berjalan paralel tanpa batas.
- Upload/download artifact memiliki deadline, sedangkan completion command mencoba ulang secara idempotent saat jaringan terganggu.
- Metode koneksi dapat dipilih per-device dari dashboard: `Polling`, `Long poll`, atau `Auto`, tanpa restart agent. Agent mulai dengan `Polling`.
- Metode `WebRTC` tersedia sebagai data channel direct untuk mouse/keyboard saat agent `1.9+` berjalan; jika handshake gagal, input otomatis fallback ke HTTP polling.
- Zoom live screen mendukung `Fit`, zoom in, zoom out, dan pan/geser saat zoom > 1; mapping klik tetap dihitung terhadap koordinat layar agent.
- Grid overlay opsional untuk membantu validasi alignment layar dan koordinat klik.
- Klik mouse jarak jauh melalui action `mouse_click` untuk left-click, double-click, dan right-click, hanya jika `allowRemoteControl` aktif di config agent.
- Pointer drag-and-drop melalui action `mouse_input` dengan event berurutan `down`, `move`, `up`, dan `cancel`. Move batch lama dikompaksi agar antrean tidak tertinggal.
- Drag yang sedang ditahan mengirim keepalive sehingga tombol mouse tidak dilepas watchdog saat pointer diam.
- Mouse wheel vertikal/horizontal dikirim sebagai pointer input. Tombol focus view memperbesar layar remote di dalam jendela browser tanpa mengunci taskbar Windows, dan toolbar focus berada di atas agar tidak menutup taskbar remote.
- Input keyboard jarak jauh melalui action `keyboard_input`, hanya jika `allowRemoteControl` dan `allowKeyboardInput` aktif di config agent.
- Copy/paste clipboard dari dashboard ke agent melalui action `clipboard_write`; agent menulis clipboard OS, lalu opsional langsung menjalankan paste ke window aktif.
- Power controls melalui action `device_power` dan `agent_restart`, hanya jika `allowPowerControl` aktif di config agent.
- Agent `1.6+` memakai keyboard state `down/up`, mendukung tahan tombol, key repeat OS, Backspace, Delete, arrow, F1-F24, modifier, numpad, dan media key.
- Koordinat pointer memakai ukuran layar kontrol agent, sehingga tetap presisi saat ukuran screenshot dan DPI Windows berbeda.
- File transfer dua arah melalui folder `fileTransferRoot`, hanya jika `allowFileTransfer` aktif.
- Upload file ke agent memakai dropzone drag-and-drop dengan fallback klik/pilih file.
- Session recording menghasilkan artifact HTML replay dari frame screenshot, hanya jika `allowSessionRecording` aktif.
- Tombol Stop dan `Ctrl+Alt+Escape` mematikan live view serta mode kontrol. Saat keyboard remote aktif, `Escape` dikirim ke device.
- Watchdog agent otomatis melepas tombol mouse yang masih tertahan ketika transport terputus atau pointer berhenti mengirim event.
- Capability negotiation menjaga rolling upgrade: agent lama tetap menerima `mouse_click`, sedangkan agent `1.5+` otomatis memakai `mouse_input`.
- Upload artifact disimpan di `storage/uploads/` secara default, bukan di folder public `server/`.

## Action Allowlist

- `health_check`: cek status agent.
- `system_info`: info OS dasar.
- `network_interfaces`: daftar interface jaringan dari API Node.js.
- `list_log_files`: daftar file log di folder yang sudah dikonfigurasi.
- `upload_log_file`: upload satu file log relatif terhadap `logDirectory`.
- `run_diagnostic`: menjalankan diagnostic command hardcoded seperti `node_version`, `npm_version`, atau `git_version`.
- `capture_screen`: ambil screenshot layar device dan upload sebagai artifact gambar.
- `mouse_click`: klik mouse pada koordinat layar yang dikirim dari live view. Payload mendukung `button` (`left`, `right`, `middle`) dan `double`.
- `mouse_input`: batch pointer berurutan untuk move dan drag-and-drop. Action ini bersifat ephemeral sehingga hasil sukses segera dibersihkan dan tidak memenuhi tabel command/audit.
- `keyboard_input`: input keyboard dari live view. Payload mendukung `kind=text` untuk karakter biasa atau `kind=key` untuk tombol seperti `enter`, `backspace`, `left`, `right`, dan modifier `control`, `alt`, `shift`.
- `keyboard_state`: event keyboard ephemeral `down/up` untuk pengalaman input stateful agent `1.6+`.
- `clipboard_write`: tulis text ke clipboard agent dan opsional paste ke window aktif. Payload mendukung `text` dan `paste`.
- `device_power`: kontrol power/display terbatas. Payload mendukung `operation=display_on`, `display_off`, `restart_device`, `sleep`, atau `hibernate`.
- `agent_restart`: minta agent keluar setelah completion; supervisor/scheduled task akan menghidupkannya lagi jika dipasang.
- `file_list`: daftar isi folder transfer agent.
- `file_pull`: ambil file dari folder transfer agent sebagai artifact dashboard.
- `file_put`: kirim upload dashboard ke folder transfer agent.
- `record_session`: rekam beberapa frame screenshot menjadi artifact HTML replay.

Payload contoh untuk `upload_log_file`:

```json
{"relativePath":"app.log"}
```

Payload contoh untuk `run_diagnostic`:

```json
{"name":"node_version"}
```

## Catatan Keamanan

Prototype ini sengaja tidak menyediakan arbitrary shell command atau akses file bebas. Remote mouse/keyboard/file/recording/power harus diaktifkan eksplisit di config agent, dibatasi permission profile device, dan tetap hanya menjalankan aksi yang ada di allowlist.

## Adaptive Transport

Fondasi saat ini memulai agent melalui `http-poll`, dengan `http-long-poll` dan `webrtc-data` tersedia sebagai metode yang dapat dipilih dari dashboard. Server mengirim preferensi transport pada setiap respons poll, sehingga metode dapat berubah tanpa restart agent.

`Polling` berarti agent bertanya ke server secara berkala lalu tidur sebentar. `Long poll` berarti agent membuka request yang ditahan server sampai ada command baru atau timeout, sehingga command bisa lebih cepat diterima tanpa spam request kosong. `Auto` mempertahankan metode stabil dan membiarkan agent fallback jika long-poll diblokir proxy.

Dashboard menyimpan `transport_mode` per device dan metode efektif terakhir. `Polling` adalah default. Pilihan `Long poll` akan tetap jatuh ke `Polling` jika runtime server tidak mendukung request panjang.

`WebRTC` sekarang memakai endpoint signaling PHP `api/webrtc.php` dan Node dependency `node-datachannel`. Jalur ini mempercepat input mouse/keyboard melalui data channel direct; frame live masih memakai HTTP snapshot sampai encoder/media track realtime ditambahkan. Pada NAT ketat, konfigurasi TURN diperlukan agar WebRTC dapat terhubung stabil.

- `APP_AGENT_LONG_POLL_MS=15000`: durasi tunggu request agent; isi `0` untuk memaksa short-poll.
- `APP_LIVE_CAPTURE_INTERVAL_MS=1000`: interval default request frame live; mode Burst menurunkannya otomatis.
- `APP_LIVE_STATUS_INTERVAL_MS=650`: interval default refresh status live.
- `APP_AGENT_POLL_PROBE_MS=60`: ritme server memeriksa command selama long-poll.
- `APP_AGENT_MODE_RECHECK_MS=1000`: interval pemeriksaan perubahan metode koneksi saat long-poll.
- `APP_AGENT_LONG_POLL_ALLOW_CLI_SERVER=false`: melindungi PHP built-in server yang single-worker agar dashboard lokal tidak tertahan.
- `APP_IDLE_STATUS_INTERVAL_MS=5000`: heartbeat status dashboard saat Live tidak aktif.
- `APP_AGENT_ONLINE_WINDOW_SECONDS=60`: batas usia heartbeat agar device dianggap aktif.
- `APP_LIVE_ACTIVITY_TTL_SECONDS=12`: berapa lama profil polling aktif dipertahankan setelah aktivitas dashboard.
- `APP_AGENT_POLL_IDLE_MS=350`: ritme polling saat tidak ada sesi live.
- `APP_AGENT_POLL_ECO_MS=120`, `APP_AGENT_POLL_FLOW_MS=45`, `APP_AGENT_POLL_BURST_MS=15`: ritme polling adaptif saat sesi live.
- `APP_POINTER_BATCH_MS=24`: interval browser mengelompokkan pointer move.
- `APP_POINTER_MAX_EVENTS=64`: batas event per batch.
- `APP_POINTER_RELEASE_TIMEOUT_MS=2500`: watchdog pelepas tombol mouse.
- `APP_POINTER_COMMAND_TTL_SECONDS=3`: membuang event pointer live yang sudah basi sebelum agent mengambilnya.
- `APP_INPUT_COMMAND_TTL_SECONDS=5`: membuang klik dan input keyboard live yang terlambat.
- `APP_WHEEL_PIXEL_PER_LINE=6`: kalibrasi pixel wheel/trackpad menjadi baris scroll remote. Angka lebih kecil berarti lebih sensitif.
- `APP_WHEEL_PAGE_LINES=24`: jumlah baris untuk event scroll bertipe page.
- `APP_WHEEL_MAX_LINES=120`: batas baris scroll per event agar gesture besar tetap terkendali.

Lapisan berikutnya dapat menambahkan WSS dan WebRTC sebagai transport lebih cepat tanpa menghapus fallback HTTP ini.
