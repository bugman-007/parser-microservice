# Dockerfile - Product microservice
FROM node:20-alpine
RUN apk add --no-cache bash tini
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src ./src
COPY start.sh ./
ENV NODE_ENV=production \
    PORT=8000 \
    UPLOAD_DIR=/opt/parser/uploads \
    RESULT_DIR=/opt/parser/results
RUN mkdir -p $UPLOAD_DIR $RESULT_DIR && chown -R node:node /app
USER node
EXPOSE 8000
ENTRYPOINT ["/sbin/tini","--"]
CMD ["bash","-lc","./start.sh"]
