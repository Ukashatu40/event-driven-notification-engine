#!/bin/bash

mv data/notification_events_new.csv data/notification_events.csv

head -3 data/notification_events.csv

wc -l data/notification_events.csv