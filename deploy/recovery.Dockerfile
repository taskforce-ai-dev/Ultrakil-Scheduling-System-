FROM postgres:16.15-alpine3.23
# Only this operations image carries encryption/SSH clients. Application images
# and the private database network do not acquire outbound backup access.
RUN apk add --no-cache python3 age openssh-client
WORKDIR /opt/ultrakil
COPY deploy/recovery.py /opt/ultrakil/recovery.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER postgres
ENTRYPOINT ["python3", "/opt/ultrakil/recovery.py"]
CMD ["schedule"]
