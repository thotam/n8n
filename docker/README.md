# n8n Docker — Queue Mode (DTP)

Triển khai n8n tự host với **Queue Mode** sử dụng Docker Compose.  
Stack: **n8n + PostgreSQL + Redis**, hỗ trợ multi-worker và custom community node.

---

## Kiến trúc

```
┌─────────────────────────────────────────────────┐
│                   baota_net                     │
│                                                 │
│  ┌──────────┐   ┌──────────┐   ┌────────────┐  │
│  │ postgres │   │  redis   │   │  n8n_dtp   │  │ ← UI + API + Trigger
│  │  :5432   │   │  :6379   │   │   :5678    │  │
│  └──────────┘   └──────────┘   └────────────┘  │
│                                      │          │
│                               ┌──────▼──────┐  │
│                               │ n8n_worker  │  │ ← Thực thi workflow
│                               │ (N replica) │  │
│                               └─────────────┘  │
└─────────────────────────────────────────────────┘
```

| Service | Image | Vai trò |
|---|---|---|
| `postgres` | `postgres:16-alpine` | Lưu trữ dữ liệu workflow, credentials |
| `redis` | `redis:7-alpine` | Queue Bull cho Queue Mode |
| `n8n_dtp` | `n8n_dtp:<VERSION>` (local build) | Main: UI, API, Webhook, Trigger |
| `n8n_worker` | `n8n_dtp:<VERSION>` (tái dùng) | Worker thực thi workflow (scalable) |

> **Network:** Dùng external network `baota_net` — phải tạo trước khi chạy.

---

## Cấu trúc thư mục

```
docker/
├── .env                   # Biến môi trường thực tế (KHÔNG commit)
├── .env.example           # Template mẫu
├── Dockerfile             # Build image n8n_dtp với patch license
├── docker-compose.yml     # Stack chính (production)
├── docker-compose.test.yml # Stack test
├── patch-license.sh       # Script patch license.js tại build time
└── README.md
```

---

## Cài đặt lần đầu

### 1. Tạo file `.env`

```bash
cp .env.example .env
```

Chỉnh sửa các giá trị bắt buộc trong `.env`:

| Biến | Mô tả | Bắt buộc |
|---|---|---|
| `VERSION` | Phiên bản n8n (vd: `1.88.0`) | ✅ |
| `N8N_ENCRYPTION_KEY` | Key mã hóa credentials (32+ ký tự ngẫu nhiên) | ✅ |
| `POSTGRES_PASSWORD` | Mật khẩu PostgreSQL | ✅ |
| `REDIS_PASSWORD` | Mật khẩu Redis | ✅ |
| `N8N_HOST` | Domain công khai của n8n (vd: `n8n.example.com`) | ✅ |
| `WEBHOOK_URL` | URL webhook công khai (vd: `https://n8n.example.com/`) | ✅ |
| `APP_PATH` | Đường dẫn trên host để mount dữ liệu | ✅ |

> ⚠️ `N8N_ENCRYPTION_KEY` phải **giống nhau** trên tất cả worker. Nếu thay đổi key sau khi đã tạo credentials, mọi credentials sẽ không giải mã được.

### 2. Tạo external network

```bash
docker network create baota_net
```

### 3. Build và khởi động

```bash
# Build image và khởi động toàn bộ stack
docker compose up -d --build
```

### 4. Kiểm tra trạng thái

```bash
docker compose ps
docker compose logs -f n8n_dtp
```

---

## Các lệnh thường dùng

### Khởi động / Dừng

```bash
# Khởi động
docker compose up -d

# Dừng (giữ dữ liệu)
docker compose down

# Dừng và xóa volumes (MẤT DỮ LIỆU)
docker compose down -v
```

### Update n8n lên version mới

> ⚠️ **Phải pull base image trước** — Docker sẽ dùng cache cũ của `n8nio/n8n` nếu bỏ qua bước này, khiến version không thay đổi sau khi build.

```bash
# 1. Pull base image latest mới nhất từ Docker Hub
docker pull n8nio/n8n:latest

# 2. Rebuild image local và restart
docker compose up -d --build
```

### Scale worker

```bash
# Tăng/giảm số lượng worker (hoặc sửa WORKER_COUNT trong .env)
docker compose up -d --scale n8n_worker=3
```

### Xem log

```bash
# Log main
docker compose logs -f n8n_dtp

# Log worker
docker compose logs -f n8n_worker

# Log tất cả
docker compose logs -f
```

### Restart một service

```bash
docker compose restart n8n_dtp
docker compose restart n8n_worker
```

---

## Dockerfile & patch-license.sh

Image `n8n_dtp` được build từ `n8nio/n8n:<VERSION>` với bước patch tại build time:

```
n8nio/n8n:<VERSION>
    └── COPY patch-license.sh
    └── RUN patch-license.sh --skip-exec   ← patch license.js
    └── USER node                           ← chạy với user an toàn
```

Script `patch-license.sh` sửa `license.js` để:
- `isLicensed()` → trả `true` cho mọi feature (trừ banner, AI features)
- `getValue()` → trả `UNLIMITED_LICENSE_QUOTA` cho mọi quota
- `getPlanName()` → trả `'Enterprise'`

---

## Biến môi trường quan trọng

### CPC1HN Member Node

Node community `n8n-nodes-cpc1hn-member` đọc endpoint OAuth2 từ env:

| Biến | Giá trị mặc định |
|---|---|
| `CPC1HN_AUTH_URL` | `https://sos.cpc1hn.com.vn/oauth/authorize` |
| `CPC1HN_TOKEN_URL` | `https://oauth.cpc1hn.com.vn/oauth/token` |
| `CPC1HN_DOCS_URL` | `https://sos.cpc1hn.com.vn` |
| `CPC1HN_API_BASE_URL` | `https://api.cpc1hn.com.vn` |

### Credentials Overwrite

Dùng để inject credentials tự động (vd: Google OAuth2):

```env
CREDENTIALS_OVERWRITE_DATA={"googleOAuth2Api":{"clientId":"xxx.googleusercontent.com","clientSecret":"xxxxx"}}
```

---

## Volumes

| Volume | Mount trong container | Nội dung |
|---|---|---|
| `postgres_data` | `/var/lib/postgresql/data` | Dữ liệu PostgreSQL |
| `redis_data` | `/data` | Dữ liệu Redis (AOF) |
| `n8n_data` | `/home/node/.n8n` | Credentials, settings, community nodes |

> Worker chia sẻ cùng volume `n8n_data` với main để dùng chung community nodes.

---

## Troubleshooting

### Container không khởi động được

```bash
# Kiểm tra log chi tiết
docker compose logs n8n_dtp

# Kiểm tra health check của postgres/redis
docker compose ps
```

### Lỗi "Encryption key mismatch"

→ Đảm bảo `N8N_ENCRYPTION_KEY` trong `.env` giống với lần khởi tạo đầu tiên.  
→ Không thay đổi key sau khi đã có credentials.

### Webhook không nhận được request

→ Kiểm tra `WEBHOOK_URL` phải là URL công khai, không phải `localhost`.  
→ Đảm bảo reverse proxy (Nginx/BaoTa) forward đúng đến port `5678`.

### Worker không nhận job

→ Kiểm tra `EXECUTIONS_MODE=queue` được set ở cả main và worker.  
→ Kiểm tra `N8N_ENCRYPTION_KEY` giống nhau trên main và worker.
