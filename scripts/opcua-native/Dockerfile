# Build context is assembled by build.mjs and contains only verified public source.
ARG NODE_RED_BASE=nodered/node-red@sha256:7d57985fde220f7d223e008a2e8f97a46dcd432009fcdfaaaf00ed3e37a540ab
FROM ${NODE_RED_BASE} AS native-build
ARG NODE_RED_BASE
ARG NODE_RED_PROFILE=5.0.4-24-minimal
ARG TOOLCHAIN_LOCK=toolchain.apk.lock
USER root
COPY scripts/${TOOLCHAIN_LOCK} /opt/build/toolchain.apk.lock
RUN xargs apk add --no-cache < /opt/build/toolchain.apk.lock
WORKDIR /opt/build
COPY package.tgz /opt/build/package.tgz
COPY scripts/ /opt/build/scripts/
RUN node scripts/prepare.mjs
WORKDIR /opt/build/package
ENV SOURCE_DATE_EPOCH=1771372800 OPCUA_CLIENT_OFFLINE_ONLY=1 BUILD_JOBS=2
RUN bash scripts/build-open62541.sh && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=/usr/local && node /opt/build/scripts/finalize.mjs

FROM ${NODE_RED_BASE}
USER root
COPY --from=native-build --chown=root:root /out/ /opt/thinglinks/opcua-native/
ENV OPCUA_OPEN62541_ADDON=/opt/thinglinks/opcua-native/opcua_open62541.node
LABEL com.mqttsnet.thinglinks-edge.opcua-native="0.6.0-chain.1"
RUN chmod -R a-w /opt/thinglinks/opcua-native && node -e "const a=require(process.env.OPCUA_OPEN62541_ADDON);if(typeof a.connectAsync!=='function')process.exit(1)"
USER node-red
