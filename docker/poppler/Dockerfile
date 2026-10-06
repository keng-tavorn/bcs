# PDF rasterizer for the Thai rendering snapshots of printed PR and PO (spec FR-PLT-009 AC3). Used by tests only:
# the PDF goes in on stdin, one page comes out as PNG on stdout (`pdftoppm … -singlefile -`), so nothing is mounted.
# Debian 12 keeps poppler 22.12 for its whole life; a security update that changes the pixels means regenerating the
# snapshots with UPDATE_PDF_SNAPSHOTS=1 after looking at them (docs/runbooks/pdf-snapshots.md).
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
