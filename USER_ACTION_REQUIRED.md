# User Action Required

Status production pada 8 Juni 2026: perlu deploy ulang setelah fitur remote clipboard, tuning wheel sensitivity 16x, zoom live screen, zoom pan, focus toolbar compact, low-latency HTTP tuning, drag-and-drop upload, neumorphic UI, WebRTC data channel, power/agent controls, dan Agent Manager GUI belum tersedia di server live.

Verifier production terakhir masih `FAILED` karena server live belum memiliki release lokal terbaru dan belum mengiklankan fitur terbaru seperti `webrtc_data_channel`, `agent_power_controls`, dan `zoom_pan`.

Pengingat tetap untuk setiap deployment berikutnya:

1. Deploy seluruh folder `server/` sebagai satu release dan pertahankan `.env` production serta folder upload.
2. Pastikan rewrite website utama tidak menangkap file nyata di `/any/server`.
3. Reset OPcache atau restart PHP-FPM/web server jika `opcache.validate_timestamps=0`.
4. Jalankan dari root proyek:

```powershell
node scripts/verify-deployment.mjs https://lppsp.ui.ac.id/any/server
```

Deployment selesai hanya ketika verifier menghasilkan `PASS` dan heartbeat agent tidak memiliki error.

Setelah server PASS, jalankan di device agent:

```powershell
cd agent
.\Device Snapshot Agent Manager.cmd
```

Dari Native Agent Manager, klik `Bootstrap Node + Dependencies` bila Node/dependency belum siap, simpan config production, lalu gunakan `Make Interactive Startup` atau `Install Interactive Startup` untuk membuat Scheduled Task `DeviceSnapshotAgent` pada user Windows interaktif. Untuk install task, buka manager sebagai Administrator atau klik `Relaunch as Admin`. Hapus/repair task `SYSTEM` lama agar tidak terjadi agent duplikat dan frame Session 0 hitam.
