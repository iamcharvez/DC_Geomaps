FROM eclipse-temurin:21.0.8_9-jre-jammy

ARG TARGETARCH
ARG PLANETILER_VERSION=0.10.2
ARG PMTILES_VERSION=1.30.0
ARG PYOSMIUM_VERSION=4.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gosu osmium-tool python3 python3-pip tini \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir "osmium==${PYOSMIUM_VERSION}" \
    && mkdir -p /opt/planetiler /opt/pmtiles \
    && curl --fail --location --retry 3 \
      "https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar" \
      --output /opt/planetiler/planetiler.jar \
    && case "$TARGETARCH" in \
         amd64) pm_arch="x86_64" ;; \
         arm64) pm_arch="arm64" ;; \
         *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl --fail --location --retry 3 \
      "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${pm_arch}.tar.gz" \
      --output /tmp/pmtiles.tar.gz \
    && tar -xzf /tmp/pmtiles.tar.gz -C /opt/pmtiles \
    && install -m 0755 /opt/pmtiles/pmtiles /usr/local/bin/pmtiles \
    && rm -rf /tmp/pmtiles.tar.gz /opt/pmtiles \
    && groupadd --gid 10001 geomap \
    && useradd --uid 10001 --gid geomap --home-dir /app --shell /usr/sbin/nologin geomap

WORKDIR /app
COPY services/worker/worker.py /app/worker.py
COPY services/worker/entrypoint.sh /usr/local/bin/dcgeomap-worker-entrypoint
RUN chmod 0755 /usr/local/bin/dcgeomap-worker-entrypoint

EXPOSE 8788
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dcgeomap-worker-entrypoint"]

