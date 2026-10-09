# Canonical Makefile. scripts/ holds the real logic; make <name> maps 1:1.
# CI calls these targets and never a framework command directly.
.PHONY: setup dev test lint build migrate health

setup:
	./scripts/setup

dev:
	./scripts/dev

test:
	./scripts/test

lint:
	./scripts/lint

build:
	./scripts/build

migrate:
	./scripts/migrate

health:
	./scripts/health