# Playwright's own image already carries Chromium, every system library it
# needs, and Xvfb -- which matters because Google Meet blocks headless browsers,
# so the bot runs headful against a virtual display instead.
FROM mcr.microsoft.com/playwright/python:v1.62.0-noble

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install real Google Chrome, not just the bundled Chromium. Google Meet serves
# a reduced UI to browsers it does not recognise as fully supported: under
# Chromium the in-call toolbar appears without captions, People or Present, so
# there is no CC control to click at all.
RUN playwright install --with-deps chrome

COPY meet_listener.py server.py tester.py assistant.py ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Normalise line endings: a CRLF shebang from a Windows checkout makes the
# kernel report "no such file or directory" for the interpreter.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Credentials are mounted here, never baked into the image: run
# `python meet_listener.py --login` on a machine with a screen and mount the
# resulting profile directory at this path.
ENV MEET_PROFILE_DIR=/creds \
    MEET_DATA_DIR=/data \
    MEET_PORT=8080 \
    MEET_HOST=0.0.0.0 \
    MEET_HEADLESS=0 \
    MEET_CHANNEL=chrome \
    PYTHONUNBUFFERED=1

RUN mkdir -p /creds /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; \
      sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4).status==200 else 1)"

# The entrypoint brings up Xvfb, then execs this.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "server.py"]
