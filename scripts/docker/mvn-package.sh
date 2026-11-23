#!/bin/sh
# Packages the Maven project in the current directory (used inside the Java build stages of the
# root Dockerfile). Tests are skipped here because CI runs them first.
#
# If a BuildKit secret named "truststore" is mounted, Maven trusts the CA certificates in it.
# This is only needed behind a TLS-intercepting proxy; without the secret the JDK default trust
# store is used.
set -eu

if [ -f /run/secrets/truststore ]; then
  export MAVEN_OPTS="-Djavax.net.ssl.trustStore=/run/secrets/truststore -Djavax.net.ssl.trustStorePassword=${TRUSTSTORE_PASSWORD:-changeit} ${MAVEN_OPTS:-}"
fi

exec mvn -B -q -DskipTests package
