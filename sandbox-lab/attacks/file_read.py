import os
print("work:", os.listdir("/work"))
print("/Users exists:", os.path.exists("/Users"))
for p in ("/work/x", "/x", "/etc/x"):
    try:
        open(p, "w").close()
        print("WROTE", p)
    except OSError:
        print("blocked", p)
