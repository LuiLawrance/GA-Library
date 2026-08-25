FROM python:3.14-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium

COPY . .

# DATA_GA is a Railway volume mount; DATA_GENERAL is symlinked into a
# subfolder of it so both directories persist on the single volume Railway
# allows per service.
CMD ["sh", "-c", "mkdir -p DATA_GA/DATA_GENERAL && ln -sfn DATA_GA/DATA_GENERAL DATA_GENERAL && uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
