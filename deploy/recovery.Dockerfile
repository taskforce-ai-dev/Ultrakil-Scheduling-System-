FROM postgres:16.15-alpine3.23
# Only this operations image carries encryption/SSH clients. Application images
# and the private database network do not acquire outbound backup access.
RUN apk add --no-cache python3 age openssh-client \
    && addgroup -S -g 10001 recovery \
    && adduser -S -D -u 10001 -G recovery -h /home/recovery recovery \
    && chmod 0700 /home/recovery
WORKDIR /opt/ultrakil
COPY deploy/recovery.py /opt/ultrakil/recovery.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER recovery
ENTRYPOINT ["python3", "/opt/ultrakil/recovery.py"]
CMD ["schedule"]
