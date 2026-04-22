# Native macOS share-sheet helper.
#
# Guarded so CI on Linux (electron-builder's multi-platform matrix, future
# Linux packaging) is a no-op instead of failing on missing swiftc.

UNAME_S := $(shell uname -s)

.PHONY: all clean

ifeq ($(UNAME_S),Darwin)
all: sharer

sharer: main.swift
	swiftc -O main.swift -o sharer

clean:
	rm -f sharer
else
all:
	@echo "sharer: skipping native build on $(UNAME_S) (darwin only)"

clean:
	@true
endif
