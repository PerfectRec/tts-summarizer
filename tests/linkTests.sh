#! /bin/bash
# p2a-services
#
#  Created by Murali Krishnan on 12/5/2024

# quick set of Curl tests for checking if the system works

LOCAL_HOST="http://localhost:4242"

# Get all links
echo curl -X GET "${LOCAL_HOST}/links/all"

# Check a good link
echo curl -X GET "${LOCAL_HOST}/links/check?url=https://files.paper2audio.com/0/welcome.pdf"

# Check a bad link
curl -X GET "$LOCAL_HOST/links/check?url=whathttps://files.paper2audio.com/0/welcome.pdf"

# Add a link
# curl -X POST -H "Content-Type: application/json" -d '{"url": "https://files.paper2audio.com/0/welcome.pdf"}' $LOCAL_HOST/links
curl -X POST "$LOCAL_HOST/links?url=https://files.paper2audio.com/0/welcome.pdf&id=1234567890"
curl -X GET "${LOCAL_HOST}/links/all"
# Remove a link
curl -X DELETE "$LOCAL_HOST/links?url=https://files.paper2audio.com/0/welcome.pdf&id=1234567890"
curl -X GET "${LOCAL_HOST}/links/all"

# Modify a link and the delete
curl -X POST "$LOCAL_HOST/links?url=https://files.paper2audio.com/0/welcome-wrong.pdf"
curl -X PUT "$LOCAL_HOST/links?oldUrl=https://files.paper2audio.com/0/welcome-wrong.pdf&newUrl=https://files.paper2audio.com/0/welcome.pdf"
curl -X GET "${LOCAL_HOST}/links/all"
curl -X DELETE "$LOCAL_HOST/links?url=https://files.paper2audio.com/0/welcome.pdf&id=1234567890"

# Add a couple of links and then check on removal
curl -X POST "$LOCAL_HOST/links?url=https://files.paper2audio.com/0/welcome.pdf"
curl -X POST "$LOCAL_HOST/links?url=https://files.paper2audio.com/0/welcome.pdf&id=1234567890"
curl -X GET http://localhost:4242/links/all
curl -X DELETE "$LOCAL_HOST/links?url=https://files.paper2audio.com/0/welcome.pdf&id=1234567890"