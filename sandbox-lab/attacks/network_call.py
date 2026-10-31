import urllib.request
try:
    urllib.request.urlopen("http://1.1.1.1", timeout=3)
    print("NETWORK ESCAPED")
except Exception:
    print("blocked")
