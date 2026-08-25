n = int(input())
s = input().strip()

n=str(n)
l=len(s)
sumk=0
for i in s:
    sumk+=int(i)
poss=[]
for i in range(2,l+1):
    if sumk%i==0:
        poss.append(i)

solved=0
for i in poss:
    t=sumk//i
    j=0
    p=0
    count=0
    while j<l:
        p+=int(s[j])
        if p==t:
            count+=1
            p=0
        elif p>t:
            break
        j+=1
    if count==i:
        print("YES")
        solved=1
if solved==0:
    print("NO")




n = int(input())
s = input().strip()

n=str(n)
l=len(n)
sumk=0
for i in n:
    sumk+=int(i)
poss=[]
for i in range(2,l):
    if sumk%i==0:
        poss.append(i)

solved=0
for i in poss:
    t=sumk//i
    j=0
    p=0
    count=0
    while j<l:
        p+=int(n[j])
        if p==t:
            count+=1
            p=0

        elif p>t:
            break
        j+=1

    if count==i:
        print("YES")
        solved=1

if solved==0:
    print("NO")
