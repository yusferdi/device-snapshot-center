# Deployment

Target production saat ini:

```text
https://lppsp.ui.ac.id/any/server
```

## Release Checklist

1. Deploy seluruh isi folder `server/` sebagai satu release. Jangan upload file PHP dan asset secara terpisah ke folder aktif.
2. Pertahankan `.env` production dan folder upload di luar release baru.
3. Set `APP_RELEASE` ke commit SHA/release ID agar release production mudah dilacak.
4. Jika hosting mendukungnya, upload ke folder release baru lalu ganti document-root atau symlink dalam satu operasi.
5. Pastikan rewrite website utama tidak menangkap file yang benar-benar ada di `/any/server`.
6. Jika `opcache.validate_timestamps=0`, reset OPcache atau restart PHP-FPM/web server setelah release diganti.
7. Verifikasi release dari root proyek:

```powershell
node scripts/verify-deployment.mjs https://lppsp.ui.ac.id/any/server
```

Deployment selesai hanya jika verifier menghasilkan `PASS`. Respons `version.php` harus JSON, header halaman harus memiliki release yang sama, dan seluruh hash file kritis harus cocok.

Untuk Apache, letakkan pengecualian berikut di atas fallback SPA:

```apache
RewriteCond %{REQUEST_URI} ^/any/server(?:/|$)
RewriteRule ^ - [END]
```

Untuk Nginx, pastikan `try_files` memeriksa file/folder nyata sebelum fallback aplikasi utama. `version.php` wajib dikirim ke PHP-FPM dan menghasilkan JSON, bukan HTML SPA.

## Rollback

Kembalikan document-root atau symlink ke release sebelumnya sebagai satu operasi, lalu reset OPcache bila diperlukan. Jalankan verifier lagi setelah rollback.
