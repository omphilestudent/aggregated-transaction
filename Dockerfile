# syntax=docker/dockerfile:1.7
#
# One Dockerfile for the whole platform. Every runnable image is a named target:
#
#   docker build --target aggregation-service -t aggregation-service:local .
#
# Targets:
#   customer-service, account-service, transaction-service, aggregation-service, api-gateway
#       Spring Boot jars on a JRE-only image, running as a non-root user.
#   frontend
#       React/Vite production build served by nginx (proxies /api/v1/ to api-gateway).
#
# Optional BuildKit secret "truststore": needed only behind a TLS-intercepting proxy, so Maven
# inside the build can download dependencies. See the README ("Corporate TLS proxies").
#   docker build --secret id=truststore,src=.local/truststore.jks --target <target> .
#
# Tests are not run inside the image. CI runs them before any image is built (see
# .github/workflows/ci.yml and the README), which keeps image builds fast and deterministic.

ARG MAVEN_IMAGE=maven:3.9-eclipse-temurin-21
ARG JRE_IMAGE=eclipse-temurin:21-jre-alpine
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

# ============================================================== Java build stages
FROM ${MAVEN_IMAGE} AS build-customer-service
WORKDIR /workspace
COPY scripts/docker/mvn-package.sh /usr/local/bin/mvn-package
COPY customer-service/pom.xml ./
COPY customer-service/src ./src
RUN --mount=type=cache,target=/root/.m2 --mount=type=secret,id=truststore,required=false \
    mvn-package

FROM ${MAVEN_IMAGE} AS build-account-service
WORKDIR /workspace
COPY scripts/docker/mvn-package.sh /usr/local/bin/mvn-package
COPY account-service/pom.xml ./
COPY account-service/src ./src
RUN --mount=type=cache,target=/root/.m2 --mount=type=secret,id=truststore,required=false \
    mvn-package

FROM ${MAVEN_IMAGE} AS build-transaction-service
WORKDIR /workspace
COPY scripts/docker/mvn-package.sh /usr/local/bin/mvn-package
COPY transaction-service/pom.xml ./
COPY transaction-service/src ./src
RUN --mount=type=cache,target=/root/.m2 --mount=type=secret,id=truststore,required=false \
    mvn-package

FROM ${MAVEN_IMAGE} AS build-aggregation-service
WORKDIR /workspace
COPY scripts/docker/mvn-package.sh /usr/local/bin/mvn-package
COPY aggregation-service/pom.xml ./
COPY aggregation-service/src ./src
RUN --mount=type=cache,target=/root/.m2 --mount=type=secret,id=truststore,required=false \
    mvn-package

FROM ${MAVEN_IMAGE} AS build-case-service
WORKDIR /workspace
COPY scripts/docker/mvn-package.sh /usr/local/bin/mvn-package
COPY case-service/pom.xml ./
COPY case-service/src ./src
RUN --mount=type=cache,target=/root/.m2 --mount=type=secret,id=truststore,required=false \
    mvn-package

FROM ${MAVEN_IMAGE} AS build-api-gateway
WORKDIR /workspace
COPY scripts/docker/mvn-package.sh /usr/local/bin/mvn-package
COPY api-gateway/pom.xml ./
COPY api-gateway/src ./src
RUN --mount=type=cache,target=/root/.m2 --mount=type=secret,id=truststore,required=false \
    mvn-package

# ============================================================== Java runtime base
# JRE only, no build tooling or sources. Non-root user. Container-aware JVM sizing.
FROM ${JRE_IMAGE} AS java-runtime
RUN addgroup -S app && adduser -S -G app app
WORKDIR /app
ENV JAVA_OPTS="-XX:MaxRAMPercentage=60 -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -XX:+ExitOnOutOfMemoryError"
USER app
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/app.jar"]

FROM java-runtime AS customer-service
COPY --from=build-customer-service --chown=app:app /workspace/target/*-SNAPSHOT.jar /app/app.jar
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:8081/actuator/health || exit 1

FROM java-runtime AS account-service
COPY --from=build-account-service --chown=app:app /workspace/target/*-SNAPSHOT.jar /app/app.jar
EXPOSE 8082
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:8082/actuator/health || exit 1

FROM java-runtime AS transaction-service
COPY --from=build-transaction-service --chown=app:app /workspace/target/*-SNAPSHOT.jar /app/app.jar
EXPOSE 8083
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:8083/actuator/health || exit 1

FROM java-runtime AS aggregation-service
COPY --from=build-aggregation-service --chown=app:app /workspace/target/*-SNAPSHOT.jar /app/app.jar
EXPOSE 8088
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:8088/actuator/health || exit 1

FROM java-runtime AS case-service
COPY --from=build-case-service --chown=app:app /workspace/target/*-SNAPSHOT.jar /app/app.jar
EXPOSE 8084
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:8084/actuator/health || exit 1

FROM java-runtime AS api-gateway
COPY --from=build-api-gateway --chown=app:app /workspace/target/*-SNAPSHOT.jar /app/app.jar
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:8000/actuator/health || exit 1

# ============================================================== Frontend
FROM ${NODE_IMAGE} AS build-frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM ${NGINX_IMAGE} AS frontend
RUN rm -f /etc/nginx/conf.d/default.conf
COPY frontend/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build-frontend /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
