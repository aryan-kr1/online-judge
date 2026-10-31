import sys


def main():
    data = sys.stdin.read().split()
    n, target = int(data[0]), int(data[1])
    seen = set()
    for x in map(int, data[2 : 2 + n]):
        if target - x in seen:
            print("YES")
            return
        seen.add(x)
    print("NO")


main()
