#!/usr/bin/env bash
while true; do
  java -jar "$1"
  echo "exit=$?, restart in 1s"
  sleep 1
done
