FROM node:20-alpine
WORKDIR /otel
COPY package.json .
RUN npm install --omit=dev
COPY tracing.js .