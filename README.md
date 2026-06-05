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
- `APP_UPLOAD_DIR`
- `APP_MAX_UPLOAD_BYTES`

Untuk testing lokal di folder proyek seperti kondisi sekarang, `APP_BASE_PATH=auto` sudah cukup.

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

Agent akan enroll sekali, menyimpan token di `agent/agent.state.json`, lalu memilih HTTP long-poll adaptif. Jika request panjang diblokir proxy, circuit breaker otomatis turun ke short-poll dan mencoba upgrade kembali tanpa restart agent.

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
- Grid overlay opsional untuk membantu validasi alignment layar dan koordinat klik.
- Klik mouse jarak jauh melalui action `mouse_click` untuk left-click, double-click, dan right-click, hanya jika `allowRemoteControl` aktif di config agent.
- Pointer drag-and-drop melalui action `mouse_input` dengan event berurutan `down`, `move`, `up`, dan `cancel`. Move batch lama dikompaksi agar antrean tidak tertinggal.
- Input keyboard jarak jauh melalui action `keyboard_input`, hanya jika `allowRemoteControl` dan `allowKeyboardInput` aktif di config agent.
- File transfer dua arah melalui folder `fileTransferRoot`, hanya jika `allowFileTransfer` aktif.
- Session recording menghasilkan artifact HTML replay dari frame screenshot, hanya jika `allowSessionRecording` aktif.
- Tombol Stop dan tombol Escape mematikan live view serta mode kontrol klik dari dashboard.
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

Fondasi saat ini menyediakan `http-long-poll` sebagai jalur utama dan `http-poll` sebagai fallback. Server mengirim capability transport pada setiap respons poll, sehingga nilai `.env` dapat berubah tanpa restart agent.

- `APP_AGENT_LONG_POLL_MS=15000`: durasi tunggu request agent; isi `0` untuk memaksa short-poll.
- `APP_AGENT_POLL_PROBE_MS=120`: ritme server memeriksa command selama long-poll.
- `APP_AGENT_LONG_POLL_ALLOW_CLI_SERVER=false`: melindungi PHP built-in server yang single-worker agar dashboard lokal tidak tertahan.
- `APP_POINTER_BATCH_MS=48`: interval browser mengelompokkan pointer move.
- `APP_POINTER_MAX_EVENTS=64`: batas event per batch.
- `APP_POINTER_RELEASE_TIMEOUT_MS=2500`: watchdog pelepas tombol mouse.

Lapisan berikutnya dapat menambahkan WSS dan WebRTC sebagai transport lebih cepat tanpa menghapus fallback HTTP ini.
