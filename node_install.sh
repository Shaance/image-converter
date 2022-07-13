#!/bin/sh

for folder in $(find './lib' -type d -depth 2)
do
  echo "Running node install in" $folder
  npm i --prefix $folder
done