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
- `enrollmentCode`: samakan dengan `APP_ENROLLMENT_CODE` di `.env`
- `deviceName`: nama yang muncul di dashboard
- `logDirectory`: folder log yang boleh dibaca agent
- `fileTransferRoot`: folder aman untuk file transfer dua arah
- `allowKeyboardInput`: aktifkan input keyboard remote jika memang dibutuhkan
- `allowFileTransfer`: aktifkan file manager remote
- `allowSessionRecording`: aktifkan recording artifact berbasis screenshot

3. Jalankan agent:

```powershell
cd agent
npm.cmd install
node agent.js
```

Agent menyimpan token di `agent/agent.state.json`, lalu memulai HTTP polling dan mengikuti pilihan metode dari dashboard. Jika token ditolak setelah deployment atau pemulihan database, agent otomatis melakukan enrollment ulang. Jika request panjang diblokir proxy, circuit breaker otomatis turun ke short-poll tanpa restart agent.

## Fitur Yang Ada

- Login admin dengan password dari `.env`.
- Device enroll otomatis saat agent berjalan.
- Dashboard PHP menampilkan address book, device profile, antrean tugas, riwayat hasil, artifact, dan audit event.
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
- Grid overlay opsional untuk membantu validasi alignment layar dan koordinat klik.
- Klik mouse jarak jauh melalui action `mouse_click` untuk left-click, double-click, dan right-click, hanya jika `allowRemoteControl` aktif di config agent.
- Pointer drag-and-drop melalui action `mouse_input` dengan event berurutan `down`, `move`, `up`, dan `cancel`. Move batch lama dikompaksi agar antrean tidak tertinggal.
- Drag yang sedang ditahan mengirim keepalive sehingga tombol mouse tidak dilepas watchdog saat pointer diam.
- Mouse wheel vertikal/horizontal dikirim sebagai pointer input, termasuk saat fullscreen.
- Input keyboard jarak jauh melalui action `keyboard_input`, hanya jika `allowRemoteControl` dan `allowKeyboardInput` aktif di config agent.
- Agent `1.6+` memakai keyboard state `down/up`, mendukung tahan tombol, key repeat OS, Backspace, Delete, arrow, F1-F24, modifier, numpad, dan media key.
- Koordinat pointer memakai ukuran layar kontrol agent, sehingga tetap presisi saat ukuran screenshot dan DPI Windows berbeda.
- File transfer dua arah melalui folder `fileTransferRoot`, hanya jika `allowFileTransfer` aktif.
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

Prototype ini sengaja tidak menyediakan arbitrary shell command atau akses file bebas. Remote mouse/keyboard/file/recording harus diaktifkan eksplisit di config agent, dibatasi permission profile device, dan tetap hanya menjalankan aksi yang ada di allowlist.

## Adaptive Transport

Fondasi saat ini memulai agent melalui `http-poll`, dengan `http-long-poll` tersedia sebagai metode yang dapat dipilih dari dashboard. Server mengirim preferensi transport pada setiap respons poll, sehingga metode dapat berubah tanpa restart agent.

Dashboard menyimpan `transport_mode` per device dan metode efektif terakhir. `Polling` adalah default. Pilihan `Long poll` akan tetap jatuh ke `Polling` jika runtime server tidak mendukung request panjang; `Auto` mempertahankan metode stabil saat ini dan circuit breaker agent tetap dapat fallback ke polling.

- `APP_AGENT_LONG_POLL_MS=15000`: durasi tunggu request agent; isi `0` untuk memaksa short-poll.
- `APP_AGENT_POLL_PROBE_MS=120`: ritme server memeriksa command selama long-poll.
- `APP_AGENT_MODE_RECHECK_MS=1000`: interval pemeriksaan perubahan metode koneksi saat long-poll.
- `APP_AGENT_LONG_POLL_ALLOW_CLI_SERVER=false`: melindungi PHP built-in server yang single-worker agar dashboard lokal tidak tertahan.
- `APP_IDLE_STATUS_INTERVAL_MS=5000`: heartbeat status dashboard saat Live tidak aktif.
- `APP_AGENT_ONLINE_WINDOW_SECONDS=60`: batas usia heartbeat agar device dianggap aktif.
- `APP_LIVE_ACTIVITY_TTL_SECONDS=12`: berapa lama profil polling aktif dipertahankan setelah aktivitas dashboard.
- `APP_AGENT_POLL_IDLE_MS=500`: ritme polling saat tidak ada sesi live.
- `APP_AGENT_POLL_ECO_MS=180`, `APP_AGENT_POLL_FLOW_MS=75`, `APP_AGENT_POLL_BURST_MS=30`: ritme polling adaptif saat sesi live.
- `APP_POINTER_BATCH_MS=48`: interval browser mengelompokkan pointer move.
- `APP_POINTER_MAX_EVENTS=64`: batas event per batch.
- `APP_POINTER_RELEASE_TIMEOUT_MS=2500`: watchdog pelepas tombol mouse.
- `APP_POINTER_COMMAND_TTL_SECONDS=3`: membuang event pointer live yang sudah basi sebelum agent mengambilnya.
- `APP_INPUT_COMMAND_TTL_SECONDS=5`: membuang klik dan input keyboard live yang terlambat.

Lapisan berikutnya dapat menambahkan WSS dan WebRTC sebagai transport lebih cepat tanpa menghapus fallback HTTP ini.
