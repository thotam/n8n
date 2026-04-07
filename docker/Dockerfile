# Pre-patch license.js tại build time → không cần user: root lúc chạy
ARG VERSION=latest
FROM n8nio/n8n:${VERSION}

# Chạy bước patch với root trong quá trình build (an toàn hơn runtime root)
USER root
COPY patch-license.sh /tmp/patch-license.sh
RUN sh /tmp/patch-license.sh --skip-exec && rm /tmp/patch-license.sh \
	# Đảm bảo mount point có ownership đúng (fix volume cũ tạo bởi root)
	&& mkdir -p /home/node/.n8n \
	&& chown -R node:node /home/node

# Trở về user mặc định của n8n image
USER node
