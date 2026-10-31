#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cstdio>
int main() {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(80);
    inet_pton(AF_INET, "1.1.1.1", &a.sin_addr);
    if (connect(s, (sockaddr*)&a, sizeof a) == 0) {
        printf("NETWORK ESCAPED\n");
    } else {
        printf("blocked\n");
    }
}
