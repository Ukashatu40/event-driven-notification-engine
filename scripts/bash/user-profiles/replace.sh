#!/bin/bash

mv data/user_profiles_new.csv data/user_profiles.csv

head -2 data/user_profiles.csv

wc -l data/user_profiles.csv