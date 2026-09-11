FROM nodered/node-red:5.0.4-24-minimal
USER root
RUN apk add --no-cache socat python3 make g++ linux-headers
COPY --chown=node-red:node-red . /opt/rtu-lab
USER node-red
ENV npm_config_cache=/data/.npm
ENTRYPOINT ["/bin/sh", "/opt/rtu-lab/bootstrap.sh"]
