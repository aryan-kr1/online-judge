import sys


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    print(sum(map(int, data[1 : 1 + n])))


main()
